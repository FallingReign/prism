#!/usr/bin/env python3
"""Store and use a Prism developer token without exposing the token to callers."""

from __future__ import annotations

import argparse
import ctypes
import getpass
import json
import os
import re
import subprocess
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

try:
    import tkinter as tk
    from tkinter import messagebox
except ImportError:
    tk = None
    messagebox = None


TOKEN_PATTERN = re.compile(r"^prism_dev_[A-Za-z0-9_-]{8,}$")
DEFAULT_TIMEOUT_SECONDS = 20
GENERIC_CREDENTIAL = 1
CRED_PERSIST_LOCAL_MACHINE = 2
ERROR_NOT_FOUND = 1168
ERROR_INSUFFICIENT_BUFFER = 122
SECRET_FIELD_NAMES = {"token", "access_token", "refresh_token", "client_secret", "authorization"}
EXECUTION_IDENTITIES = {"user", "bot", "automatic", "selectable"}
TOKEN_PRESETS = {"read_only", "messages_only", "full_slack_bridge", "custom"}
UNAVAILABLE_REASONS = {"slack_reauth_required", "missing_user_identity", "missing_bot_identity", "missing_execution_identity"}
EXPERIMENT_TTLS = {"24h", "7d"}
DIAGNOSTIC_SECRET_PATTERNS = (
    re.compile(r"prism_dev_[A-Za-z0-9_-]{8,}", re.IGNORECASE),
    re.compile(r"(?:xox[baprs]|xoxe|xapp)-[A-Za-z0-9-]{8,}", re.IGNORECASE),
    re.compile(r"\bbearer\s+\S+", re.IGNORECASE),
    re.compile(r"\b(?:access|refresh)_token\s*[:=]", re.IGNORECASE),
    re.compile(r"\bclient_secret\s*[:=]", re.IGNORECASE),
)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request: Request, fp: Any, code: int, msg: str, headers: Any, new_url: str) -> None:
        raise PrismCredentialError("Prism returned an unexpected redirect; the request was not followed.")


_HTTP_OPENER = build_opener(_NoRedirect)


class PrismCredentialError(RuntimeError):
    """A redacted, actionable credential or request error."""


@dataclass(frozen=True)
class SafeResponse:
    """A deliberately projected Prism response."""

    status: int
    ok: bool
    data: Mapping[str, Any]
    headers: Mapping[str, str]


def normalize_origin(raw_origin: str, *, allow_insecure_http: bool = False) -> str:
    """Normalize a Prism origin and reject ambiguous URL input."""

    value = raw_origin.strip()
    if not value:
        raise PrismCredentialError("A Prism host address is required.")
    has_scheme = "://" in value
    if not has_scheme and not allow_insecure_http:
        raise PrismCredentialError("A bare host requires explicit confirmation before using HTTP.")
    candidate = value if has_scheme else f"http://{value}"
    try:
        parts = urlsplit(candidate)
    except ValueError as error:
        raise PrismCredentialError("The Prism host address is malformed.") from error
    if parts.scheme not in {"http", "https"}:
        raise PrismCredentialError("The Prism host must use http or https.")
    if parts.username or parts.password or parts.query or parts.fragment:
        raise PrismCredentialError("The Prism host must not contain credentials, a query, or a fragment.")
    if parts.path not in {"", "/"}:
        raise PrismCredentialError("The Prism host must not contain a path.")
    try:
        hostname = parts.hostname
        port = parts.port
    except ValueError as error:
        raise PrismCredentialError("The Prism host contains an invalid port.") from error
    if not hostname:
        raise PrismCredentialError("The Prism host must include a hostname or IP address.")
    try:
        hostname = hostname.encode("idna").decode("ascii").lower()
    except UnicodeError as error:
        raise PrismCredentialError("The Prism host contains an invalid hostname.") from error
    if port is None:
        port = 443 if parts.scheme == "https" else 3732
    if not 1 <= port <= 65535:
        raise PrismCredentialError("The Prism host contains an invalid port.")
    netloc = f"[{hostname}]" if ":" in hostname and not hostname.startswith("[") else hostname
    return urlunsplit((parts.scheme, f"{netloc}:{port}", "", "", ""))


def credential_target(origin: str) -> str:
    """Return the deterministic host-scoped Windows credential target."""

    normalized = normalize_origin(origin)
    parts = urlsplit(normalized)
    hostname = parts.hostname or ""
    return f"Prism/{hostname}/developer-token"


def validate_token(token: str) -> str:
    """Validate a token locally without including it in an error."""

    value = token.strip()
    if not TOKEN_PATTERN.fullmatch(value):
        raise PrismCredentialError("The value does not look like a Prism developer token.")
    return value


class _CredentialBackend:
    """Private backend protocol; raw token values never leave this module."""

    def _read(self, target: str) -> str:
        raise NotImplementedError

    def _write(self, target: str, token: str) -> None:
        raise NotImplementedError

    def _delete(self, target: str) -> None:
        raise NotImplementedError


if os.name == "nt":
    from ctypes import wintypes

    class _Credential(ctypes.Structure):
        _fields_ = [
            ("Flags", wintypes.DWORD),
            ("Type", wintypes.DWORD),
            ("TargetName", ctypes.c_wchar_p),
            ("Comment", ctypes.c_wchar_p),
            ("LastWritten", wintypes.FILETIME),
            ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
            ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD),
            ("Attributes", ctypes.c_void_p),
            ("TargetAlias", ctypes.c_wchar_p),
            ("UserName", ctypes.c_wchar_p),
        ]


class _WindowsCredentialBackend(_CredentialBackend):
    """Windows Credential Manager backend using the native Advapi32 API."""

    def __init__(self) -> None:
        if os.name != "nt":
            raise PrismCredentialError("Windows Credential Manager is available only on Windows.")
        advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
        self._read_native = advapi.CredReadW
        self._read_native.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.POINTER(_Credential))]
        self._read_native.restype = ctypes.c_int
        self._write_native = advapi.CredWriteW
        self._write_native.argtypes = [ctypes.POINTER(_Credential), ctypes.c_uint32]
        self._write_native.restype = ctypes.c_int
        self._delete_native = advapi.CredDeleteW
        self._delete_native.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
        self._delete_native.restype = ctypes.c_int
        self._free = advapi.CredFree
        self._free.argtypes = [ctypes.c_void_p]
        self._free.restype = None

    def _read(self, target: str) -> str:
        credential = ctypes.POINTER(_Credential)()
        if not self._read_native(target, GENERIC_CREDENTIAL, 0, ctypes.byref(credential)):
            error = ctypes.get_last_error()
            if error == ERROR_NOT_FOUND:
                raise PrismCredentialError("No Prism credential is stored for this host.")
            raise PrismCredentialError("Windows Credential Manager could not read the Prism credential.")
        try:
            blob = ctypes.string_at(credential.contents.CredentialBlob, credential.contents.CredentialBlobSize)
        finally:
            self._free(ctypes.cast(credential, ctypes.c_void_p))
        try:
            return validate_token(blob.decode("utf-8"))
        except (UnicodeDecodeError, PrismCredentialError) as error:
            raise PrismCredentialError("The stored Prism credential is invalid.") from error

    def _write(self, target: str, token: str) -> None:
        value = validate_token(token)
        blob = value.encode("utf-8")
        blob_buffer = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        credential = _Credential()
        credential.Type = GENERIC_CREDENTIAL
        credential.TargetName = target
        credential.CredentialBlobSize = len(blob)
        credential.CredentialBlob = ctypes.cast(blob_buffer, ctypes.POINTER(ctypes.c_ubyte))
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE
        credential.UserName = "prism-developer-token"
        if not self._write_native(ctypes.byref(credential), 0):
            raise PrismCredentialError("Windows Credential Manager could not store the Prism credential.")

    def _delete(self, target: str) -> None:
        if not self._delete_native(target, GENERIC_CREDENTIAL, 0):
            error = ctypes.get_last_error()
            if error != ERROR_NOT_FOUND:
                raise PrismCredentialError("Windows Credential Manager could not remove the Prism credential.")


class _FileCredentialBackend(_CredentialBackend):
    """Explicit opt-in fallback outside the repository."""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or _fallback_path()

    def _read(self, target: str) -> str:
        with self._locked():
            self._verify_private()
            data = self._load()
            try:
                return validate_token(str(data["credentials"][target]))
            except (KeyError, TypeError, PrismCredentialError) as error:
                raise PrismCredentialError("No valid fallback Prism credential is stored for this host.") from error

    def _write(self, target: str, token: str) -> None:
        with self._locked():
            value = validate_token(token)
            try:
                previous = self.path.read_bytes() if self.path.exists() else None
            except OSError as error:
                raise PrismCredentialError("The fallback Prism credential could not be read before replacement.") from error
            self._ensure_private()
            data = self._load() if self.path.exists() and self.path.stat().st_size > 0 else {"credentials": {}}
            credentials = data.setdefault("credentials", {})
            credentials[target] = value
            self._replace(data, previous, "stored")

    def _delete(self, target: str) -> None:
        with self._locked():
            self._verify_private()
            data = self._load()
            credentials = data.get("credentials", {})
            if target in credentials:
                del credentials[target]
                try:
                    previous = self.path.read_bytes()
                except OSError as error:
                    raise PrismCredentialError("The fallback Prism credential could not be read before removal.") from error
                self._replace(data, previous, "removed")

    def _replace(self, data: Mapping[str, Any], previous: bytes | None, operation: str) -> None:
        temporary = self.path.with_name(f".{self.path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.unlink(missing_ok=True)
            with temporary.open("w", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(data, indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            self._ensure_private(temporary)
            os.replace(temporary, self.path)
            self._verify_private()
        except OSError as error:
            self._restore(previous, temporary)
            raise PrismCredentialError(f"The fallback Prism credential could not be {operation}.") from error
        except PrismCredentialError:
            self._restore(previous, temporary)
            raise

    @contextmanager
    def _locked(self):
        if os.name != "nt":
            raise PrismCredentialError("The fallback file backend is currently supported only on Windows.")
        lock_path = self.path.with_name(f".{self.path.name}.lock")
        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            with lock_path.open("a+b") as lock_file:
                self._ensure_private(lock_path)
                import msvcrt
                lock_file.seek(0, os.SEEK_END)
                if lock_file.tell() == 0:
                    lock_file.write(b"0")
                    lock_file.flush()
                lock_file.seek(0)
                msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
                try:
                    yield
                finally:
                    lock_file.seek(0)
                    msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
        except (OSError, ImportError) as error:
            raise PrismCredentialError("The fallback Prism credential file could not be locked safely.") from error

    def _restore(self, previous: bytes | None, temporary: Path) -> None:
        try:
            temporary.unlink(missing_ok=True)
            if previous is None:
                self.path.unlink(missing_ok=True)
            else:
                self.path.write_bytes(previous)
                os.chmod(self.path, 0o600)
                self._ensure_private()
        except OSError as error:
            raise PrismCredentialError("The fallback Prism credential could not be restored after a write failure.") from error

    def _load(self) -> dict[str, Any]:
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except FileNotFoundError as error:
            raise PrismCredentialError("The fallback Prism credential file does not exist.") from error
        except (OSError, json.JSONDecodeError) as error:
            raise PrismCredentialError("The fallback Prism credential file could not be read.") from error
        if not isinstance(value, dict) or not isinstance(value.get("credentials"), dict):
            raise PrismCredentialError("The fallback Prism credential file has an invalid format.")
        return value

    def _ensure_private(self, path: Path | None = None) -> None:
        target_path = path or self.path
        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if not target_path.exists():
                target_path.touch(mode=0o600)
            os.chmod(target_path, 0o600)
        except OSError as error:
            raise PrismCredentialError("The fallback Prism credential file could not be made private.") from error
        if os.name != "nt":
            raise PrismCredentialError("The fallback file backend is currently supported only on Windows.")
        principal = next(principal for principal in _current_windows_principals() if principal.startswith("*"))
        try:
            subprocess.run(
                ["icacls", str(target_path), "/inheritance:r", "/grant:r", f"{principal}:F"],
                capture_output=True,
                text=True,
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PrismCredentialError("The fallback Prism credential file could not be assigned a private ACL.") from error
        self._verify_private(target_path)

    def _verify_private(self, path: Path | None = None) -> None:
        target_path = path or self.path
        if not target_path.exists():
            raise PrismCredentialError("The fallback Prism credential file does not exist.")
        if os.name != "nt":
            raise PrismCredentialError("The fallback file backend is currently supported only on Windows.")
        current_principals = _current_windows_principals()
        try:
            result = subprocess.run(
                ["icacls", str(target_path)],
                capture_output=True,
                text=True,
                check=True,
            )
        except (OSError, subprocess.CalledProcessError) as error:
            raise PrismCredentialError("The fallback Prism credential ACL could not be inspected.") from error
        allowed_principals = current_principals | {"nt authority\\system", "builtin\\administrators"}
        principals = set()
        path_prefix = str(target_path).lower()
        for raw_line in result.stdout.splitlines():
            line = raw_line.strip()
            if not line or line.lower().startswith("successfully processed"):
                continue
            if line.lower().startswith(path_prefix):
                line = line[len(path_prefix) :].strip()
            if ":(" not in line:
                continue
            principals.add(line.split(":(", 1)[0].strip().lower())
        if not principals or not principals.intersection(current_principals) or not principals.issubset(allowed_principals):
            raise PrismCredentialError("The fallback Prism credential file does not have a verified user-only ACL.")


class _EphemeralBackend(_CredentialBackend):
    """Private backend used to validate a newly entered token before storage."""

    def __init__(self, token: str) -> None:
        self._token = validate_token(token)

    def _read(self, target: str) -> str:
        return self._token

    def _write(self, target: str, token: str) -> None:
        raise PrismCredentialError("Ephemeral credentials cannot be written.")

    def _delete(self, target: str) -> None:
        raise PrismCredentialError("Ephemeral credentials cannot be deleted.")


def _fallback_path() -> Path:
    root = os.environ.get("APPDATA")
    if not root:
        root = str(Path.home() / "AppData" / "Roaming")
    return Path(root) / "Prism" / "credentials.json"


def _current_windows_principals() -> set[str]:
    if os.name != "nt":
        raise PrismCredentialError("The current Windows user could not be determined on this platform.")
    advapi = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    kernel32 = ctypes.WinDLL("Kernel32.dll", use_last_error=True)
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.restype = ctypes.c_void_p
    open_process_token = advapi.OpenProcessToken
    open_process_token.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_void_p)]
    open_process_token.restype = ctypes.c_int
    get_token_information = advapi.GetTokenInformation
    get_token_information.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
    get_token_information.restype = ctypes.c_int
    convert_sid = advapi.ConvertSidToStringSidW
    convert_sid.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_wchar_p)]
    convert_sid.restype = ctypes.c_int
    lookup_account_sid = advapi.LookupAccountSidW
    lookup_account_sid.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32), ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
    lookup_account_sid.restype = ctypes.c_int
    local_free = kernel32.LocalFree
    local_free.argtypes = [ctypes.c_void_p]
    close_handle = kernel32.CloseHandle
    close_handle.argtypes = [ctypes.c_void_p]

    token_handle = ctypes.c_void_p()
    if not open_process_token(get_current_process(), 8, ctypes.byref(token_handle)):
        raise PrismCredentialError("The current Windows process token could not be opened.")
    try:
        required_size = ctypes.c_uint32()
        get_token_information(token_handle, 1, None, 0, ctypes.byref(required_size))
        if required_size.value == 0:
            raise PrismCredentialError("The current Windows user SID could not be read.")
        token_buffer = ctypes.create_string_buffer(required_size.value)
        if not get_token_information(token_handle, 1, token_buffer, required_size, ctypes.byref(required_size)):
            raise PrismCredentialError("The current Windows user SID could not be read.")

        class _SidAndAttributes(ctypes.Structure):
            _fields_ = [("sid", ctypes.c_void_p), ("attributes", ctypes.c_uint32)]

        class _TokenUser(ctypes.Structure):
            _fields_ = [("user", _SidAndAttributes)]

        token_user = ctypes.cast(token_buffer, ctypes.POINTER(_TokenUser)).contents
        sid_text = ctypes.c_wchar_p()
        if not convert_sid(token_user.user.sid, ctypes.byref(sid_text)):
            raise PrismCredentialError("The current Windows user SID could not be converted.")
        try:
            sid_principal = f"*{sid_text.value}"
            name_size = ctypes.c_uint32()
            domain_size = ctypes.c_uint32()
            sid_type = ctypes.c_uint32()
            lookup_account_sid(None, token_user.user.sid, None, ctypes.byref(name_size), None, ctypes.byref(domain_size), ctypes.byref(sid_type))
            names: set[str] = {sid_principal.lower()}
            if ctypes.get_last_error() == ERROR_INSUFFICIENT_BUFFER:
                name = ctypes.create_unicode_buffer(name_size.value)
                domain = ctypes.create_unicode_buffer(domain_size.value)
                if lookup_account_sid(None, token_user.user.sid, name, ctypes.byref(name_size), domain, ctypes.byref(domain_size), ctypes.byref(sid_type)):
                    names.add(name.value.lower())
                    if domain.value:
                        names.add(f"{domain.value}\\{name.value}".lower())
            return names
        finally:
            local_free(ctypes.cast(sid_text, ctypes.c_void_p))
    finally:
        close_handle(token_handle)


def _select_backend(allow_file_fallback: bool) -> _CredentialBackend:
    if os.name != "nt":
        raise PrismCredentialError("The first Prism credential backend is supported only on Windows.")
    try:
        return _WindowsCredentialBackend()
    except (OSError, PrismCredentialError):
        if allow_file_fallback:
            return _FileCredentialBackend()
        raise


def _read_token(backend: _CredentialBackend, origin: str) -> str:
    return backend._read(credential_target(origin))


def request(
    origin: str,
    method: str,
    path: str,
    *,
    payload: Mapping[str, Any] | None = None,
    query: Mapping[str, Any] | None = None,
    surface: str | None = None,
    workspace_id: str | None = None,
    execution_mode: str | None = None,
    backend: _CredentialBackend | None = None,
    allow_file_fallback: bool = False,
) -> SafeResponse:
    """Make one allowlisted Prism request with an in-memory Authorization header."""

    normalized = normalize_origin(origin)
    allowed = {
        ("GET", "/v1/prism/status"),
        ("GET", "/v1/prism/capabilities"),
        ("GET", "/v1/slack/api/users.list"),
        ("GET", "/v1/slack/api/conversations.list"),
        ("POST", "/v1/slack/api/chat.postMessage"),
    }
    method = method.upper()
    if (method, path) not in allowed:
        raise PrismCredentialError("This Prism request is not allowed by the skill helper.")
    if execution_mode is not None and execution_mode not in {"user", "bot", "auto"}:
        raise PrismCredentialError("The Prism execution mode must be user, bot, or auto.")
    if path.endswith("conversations.list") or path.endswith("chat.postMessage"):
        if surface not in {"public_channel", "private_channel", "dm", "mpim"}:
            raise PrismCredentialError("This Prism request requires an approved Prism surface.")
    if payload is not None:
        _reject_secret_fields(payload)
    if query is not None:
        _reject_secret_fields(query)
    credential_backend = backend or _select_backend(allow_file_fallback)
    try:
        token = _read_token(credential_backend, normalized)
    except PrismCredentialError:
        if not allow_file_fallback or backend is not None:
            raise
        token = _read_token(_FileCredentialBackend(), normalized)
    query_string = urlencode({key: value for key, value in (query or {}).items() if value is not None})
    url = f"{normalized}{path}" + (f"?{query_string}" if query_string else "")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {token}"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if surface:
        headers["X-Prism-Surface"] = surface
    if workspace_id:
        headers["X-Prism-Workspace-ID"] = workspace_id
    if execution_mode:
        headers["X-Prism-Execution-Mode"] = execution_mode
    body = json.dumps(dict(payload)).encode("utf-8") if payload is not None else None
    request_object = Request(url, data=body, headers=headers, method=method)
    try:
        with _HTTP_OPENER.open(request_object, timeout=DEFAULT_TIMEOUT_SECONDS) as response:
            response_body = response.read()
            return _safe_response(response.status, response.headers, response_body, path)
    except HTTPError as error:
        return _safe_response(error.code, error.headers, error.read(), path)
    except (OSError, URLError, TimeoutError) as error:
        raise PrismCredentialError("The Prism request could not reach the configured host.") from error


def setup_credentials(
    origin: str,
    *,
    allow_file_fallback: bool = False,
    allow_insecure_http: bool = False,
) -> SafeResponse:
    """Prompt locally, validate with Prism, then store the credential."""

    normalized = normalize_origin(origin, allow_insecure_http=allow_insecure_http)
    token = _prompt_for_token()
    ephemeral = _EphemeralBackend(token)
    response = request(normalized, "GET", "/v1/prism/status", backend=ephemeral)
    if not response.ok or not response.data.get("token", {}).get("valid"):
        raise PrismCredentialError("Prism rejected the token; no credential was stored.")
    backend = _select_backend(allow_file_fallback)
    try:
        backend._write(credential_target(normalized), token)
    except PrismCredentialError as native_error:
        if not allow_file_fallback or not isinstance(backend, _WindowsCredentialBackend):
            raise
        try:
            _read_token(backend, normalized)
        except PrismCredentialError:
            _FileCredentialBackend()._write(credential_target(normalized), token)
        else:
            raise PrismCredentialError(
                "Windows Credential Manager rejected the replacement while an older credential is still present; "
                "the file fallback was not used."
            ) from native_error
    return response


def _prompt_for_token() -> str:
    if tk is None:
        return validate_token(getpass.getpass("Prism developer token (input hidden): "))
    try:
        return _prompt_with_tkinter()
    except (RuntimeError, tk.TclError):
        return validate_token(getpass.getpass("Prism developer token (input hidden): "))


def _prompt_with_tkinter() -> str:
    if tk is None or messagebox is None:
        raise RuntimeError("A graphical prompt is unavailable.")
    root = tk.Tk()
    root.title("Store Prism developer token")
    root.resizable(False, False)
    value = tk.StringVar()
    result: dict[str, str] = {}
    tk.Label(root, text="Paste the copy-once Prism developer token.\nIt will be validated and stored locally.").pack(padx=18, pady=(16, 8))
    entry = tk.Entry(root, textvariable=value, show="*", width=56)
    entry.pack(padx=18)
    entry.focus_set()

    def submit() -> None:
        try:
            result["token"] = validate_token(value.get())
        except PrismCredentialError as error:
            messagebox.showerror("Invalid token", str(error), parent=root)
            return
        root.destroy()

    tk.Button(root, text="Validate and store", command=submit).pack(pady=16)
    root.bind("<Return>", lambda _: submit())
    root.mainloop()
    if "token" not in result:
        raise PrismCredentialError("Token setup was cancelled.")
    return result["token"]


def _safe_response(status: int, headers: Any, raw_body: bytes, path: str) -> SafeResponse:
    try:
        body = json.loads(raw_body.decode("utf-8")) if raw_body else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        body = {}
    if not isinstance(body, dict):
        body = {}
    data = _project_body(path, body)
    safe_headers = {}
    for name in ("X-Prism-Request-ID", "X-Prism-Upstream-Called", "Retry-After", "X-Slack-Req-Id"):
        value = headers.get(name)
        if value is not None:
            safe_headers[name.lower()] = str(value)
    ok = status < 400 and "error" not in body and body.get("ok", True) is not False
    return SafeResponse(status=status, ok=ok, data=data, headers=safe_headers)


def _project_body(path: str, body: Mapping[str, Any]) -> dict[str, Any]:
    if path.endswith("/status") or path.endswith("/capabilities"):
        projected: dict[str, Any] = {}
        if isinstance(body.get("requestId"), str):
            projected["requestId"] = body["requestId"]
        if isinstance(body.get("token"), dict):
            projected["token"] = _project_token(body["token"])
        if isinstance(body.get("slack"), dict):
            projected["slack"] = _project_slack(body["slack"])
        if isinstance(body.get("executionIdentity"), dict):
            projected["executionIdentity"] = _project_execution_identity(body["executionIdentity"])
        if isinstance(body.get("capabilityMap"), dict):
            projected["capabilityMap"] = _project_capability_map(body["capabilityMap"])
        if isinstance(body.get("categories"), dict):
            projected["categories"] = _project_categories(body["categories"])
        if isinstance(body.get("methods"), dict):
            projected["methods"] = _project_methods(body["methods"])
        if isinstance(body.get("unsupported"), dict):
            projected["unsupported"] = _project_unsupported(body["unsupported"])
        projected.update(_project_error_fields(body))
        return projected
    if path.endswith("users.list"):
        members = body.get("members") if isinstance(body.get("members"), list) else []
        return _project_error_fields(body) | {
            "members": [_project_user(item) for item in members if isinstance(item, dict)],
            **_project_pagination(body),
        }
    if path.endswith("conversations.list"):
        channels = body.get("channels") if isinstance(body.get("channels"), list) else []
        return _project_error_fields(body) | {
            "channels": [_project_channel(item) for item in channels if isinstance(item, dict)],
            **_project_pagination(body),
        }
    if path.endswith("chat.postMessage"):
        result = _project_error_fields(body)
        for key in ("channel", "ts"):
            if isinstance(body.get(key), str):
                result[key] = body[key]
        return result
    return _project_error_fields(body)


def _project_error_fields(body: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    if isinstance(body.get("ok"), bool):
        result["ok"] = body["ok"]
    error = _safe_diagnostic(body.get("error"))
    if error is not None:
        result["error"] = error
    if isinstance(body.get("prism"), dict):
        prism = body["prism"]
        safe_prism = {}
        for key in ("requestId", "errorClass", "method", "category", "requiredCapability", "tokenProfileId", "unavailableReason"):
            value = _safe_diagnostic(prism.get(key))
            if value is not None:
                safe_prism[key] = value
        result["prism"] = safe_prism
        if isinstance(prism.get("mutation"), dict):
            result["prism"]["mutation"] = _project_mutation(prism["mutation"])
    return result


def _safe_diagnostic(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 256:
        return None
    if any(pattern.search(value) for pattern in DIAGNOSTIC_SECRET_PATTERNS):
        return None
    return value


def _project_token(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {}
    for key in ("valid", "status", "tokenProfileId", "expiresAt", "lastUsedAt", "overlapExpiresAt"):
        item = value.get(key)
        if isinstance(item, bool):
            result[key] = item
        elif item is None and key in value:
            result[key] = None
        else:
            safe_item = _safe_diagnostic(item)
            if safe_item is not None:
                result[key] = safe_item
    return result


def _project_slack(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {}
    for key in ("connected", "reauthRequired"):
        if isinstance(value.get(key), bool):
            result[key] = value[key]
    for key in ("status", "lastErrorClass"):
        safe_item = _safe_diagnostic(value.get(key))
        if safe_item is not None:
            result[key] = safe_item
    return result


def _project_execution_identity(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {}
    if isinstance(value.get("configured"), str) and value["configured"] in EXECUTION_IDENTITIES:
        result["configured"] = value["configured"]
    if isinstance(value.get("available"), bool):
        result["available"] = value["available"]
    unavailable_reason = value.get("unavailableReason")
    if isinstance(unavailable_reason, str) and unavailable_reason in UNAVAILABLE_REASONS:
        result["unavailableReason"] = unavailable_reason
    if isinstance(value.get("modes"), dict):
        result["modes"] = {key: value["modes"][key] for key in ("user", "bot", "automatic", "selectable") if isinstance(value["modes"].get(key), bool)}
    return result


def _project_capability_map(value: Mapping[str, Any]) -> dict[str, Any]:
    result = {}
    if isinstance(value.get("version"), int):
        result["version"] = value["version"]
    if isinstance(value.get("preset"), str) and value["preset"] in TOKEN_PRESETS:
        result["preset"] = value["preset"]
    if isinstance(value.get("executionIdentity"), str) and value["executionIdentity"] in EXECUTION_IDENTITIES:
        result["executionIdentity"] = value["executionIdentity"]
    for section, fields in (
        ("surfaces", ("publicChannels", "privateChannels", "directMessages", "groupDirectMessages", "search", "filesMetadata")),
        ("actions", ("read", "search", "writeMessages", "reactions", "filesMetadata", "destructive")),
        ("deferred", ("admin", "fileTransfer", "events", "slashCommands", "interactivity", "canvases", "lists")),
    ):
        if isinstance(value.get(section), dict):
            result[section] = {key: value[section][key] for key in fields if isinstance(value[section].get(key), bool)}
    if isinstance(value.get("workspaces"), dict) and value["workspaces"].get("mode") == "linked_slack_connection":
        result["workspaces"] = {"mode": value["workspaces"]["mode"]}
    if isinstance(value.get("experiment"), dict):
        experiment = {}
        if isinstance(value["experiment"].get("enabled"), bool):
            experiment["enabled"] = value["experiment"]["enabled"]
        ttl = value["experiment"].get("ttl")
        if (isinstance(ttl, str) and ttl in EXPERIMENT_TTLS) or ttl is None:
            experiment["ttl"] = ttl
        result["experiment"] = experiment
    if isinstance(value.get("mutation"), dict):
        result["mutation"] = _project_mutation(value["mutation"])
    return result


def _project_mutation(value: Mapping[str, Any]) -> dict[str, Any]:
    return {
        key: value[key]
        for key in ("destructiveOptIn", "narrowingAppliesImmediately", "broadeningRequiresRotation")
        if isinstance(value.get(key), bool)
    }


def _project_categories(value: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, dict):
            continue
        methods = item.get("methods") if isinstance(item.get("methods"), list) else []
        result[key] = {
            "allowed": item["allowed"],
            "methods": [method for method in methods if isinstance(method, str)],
        } if isinstance(item.get("allowed"), bool) else {"methods": [method for method in methods if isinstance(method, str)]}
    return result


def _project_methods(value: Mapping[str, Any]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, dict):
            continue
        result[key] = {
            field: item[field]
            for field in ("category", "status", "requiredCapability", "supported")
            if isinstance(item.get(field), (str, bool))
        }
    return result


def _project_unsupported(value: Mapping[str, Any]) -> dict[str, Any]:
    surfaces = value.get("surfaces", [])
    return {"surfaces": [surface for surface in surfaces if isinstance(surface, str)]} if isinstance(surfaces, list) else {}


def _project_pagination(body: Mapping[str, Any]) -> dict[str, Any]:
    metadata = body.get("response_metadata")
    if not isinstance(metadata, dict) or not isinstance(metadata.get("next_cursor"), str):
        return {}
    return {"nextCursor": metadata["next_cursor"]}


def _reject_secret_fields(value: Mapping[str, Any]) -> None:
    for key, child in value.items():
        if str(key).lower() in SECRET_FIELD_NAMES:
            raise PrismCredentialError("Secret-bearing fields are not allowed in Prism requests.")
        if isinstance(child, Mapping):
            _reject_secret_fields(child)
        elif isinstance(child, (list, tuple)):
            _reject_nested_secret_fields(child)


def _reject_nested_secret_fields(value: list[Any] | tuple[Any, ...]) -> None:
    for item in value:
        if isinstance(item, Mapping):
            _reject_secret_fields(item)
        elif isinstance(item, (list, tuple)):
            _reject_nested_secret_fields(item)


def _project_user(item: Mapping[str, Any]) -> dict[str, Any]:
    profile = item.get("profile") if isinstance(item.get("profile"), dict) else {}
    result = {}
    for key in ("id", "name", "real_name"):
        safe_value = _safe_diagnostic(item.get(key))
        if safe_value is not None:
            result[key] = safe_value
    result.update({
        key: item[key]
        for key in ("deleted", "is_bot")
        if isinstance(item.get(key), bool)
    })
    for key in ("display_name", "real_name"):
        safe_value = _safe_diagnostic(profile.get(key))
        if safe_value is not None:
            result[key] = safe_value
    return result


def _project_channel(item: Mapping[str, Any]) -> dict[str, Any]:
    result = {}
    for key in ("id", "name"):
        safe_value = _safe_diagnostic(item.get(key))
        if safe_value is not None:
            result[key] = safe_value
    result.update({
        key: item[key]
        for key in ("is_private", "is_im", "is_mpim", "is_group")
        if isinstance(item.get(key), bool)
    })
    return result


def _safe_summary(response: SafeResponse, origin: str) -> dict[str, Any]:
    token = response.data.get("token", {})
    slack = response.data.get("slack", {})
    return {
        "ok": response.ok,
        "host": normalize_origin(origin),
        "credentialTarget": credential_target(origin),
        "status": response.status,
        "tokenStatus": token.get("status") if isinstance(token, dict) else None,
        "slackStatus": slack.get("status") if isinstance(slack, dict) else None,
        "requestId": response.headers.get("x-prism-request-id") or response.data.get("requestId"),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Store a Prism developer token locally without printing it.")
    parser.add_argument("--host", required=True, help="Prism origin or bare host address.")
    parser.add_argument(
        "--allow-file-fallback",
        action="store_true",
        help="Explicitly allow the private APPDATA/Prism/credentials.json fallback.",
    )
    parser.add_argument(
        "--allow-insecure-http",
        action="store_true",
        help="Confirm that a bare host may use HTTP; prefer supplying an explicit scheme.",
    )
    args = parser.parse_args(argv)
    try:
        normalized = normalize_origin(args.host, allow_insecure_http=args.allow_insecure_http)
        response = setup_credentials(
            normalized,
            allow_file_fallback=args.allow_file_fallback,
            allow_insecure_http=args.allow_insecure_http,
        )
    except PrismCredentialError as error:
        print(f"Prism credential setup failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(_safe_summary(response, normalized), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
