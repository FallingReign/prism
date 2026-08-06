# Prism Slack skill: Windows Credential Manager research

## Decision

Use built-in PowerShell `Add-Type` P/Invoke against `Advapi32.dll` for the
Windows-first credential adapter. Use `CredWriteW`, `CredReadW`, and
`CredDeleteW` with `CRED_TYPE_GENERIC`, and keep credential retrieval and the
HTTP request in the same PowerShell process. The skill must expose only a
request operation to the agent, never the raw token value.

Use a host-scoped target in the form:

```text
Prism/<lowercase IDN host>/developer-token
```

Fail closed for non-Windows hosts, missing credentials, unsupported persistence,
credential API failures, and Prism/Slack API failures. Rotation should validate
the newly entered token locally before replacing the stored credential.

## Evidence

- Microsoft documents generic credentials as application-defined credentials
  stored through the Windows Credential Manager data structures:
  [CREDENTIALW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw).
- `CredWriteW` writes credentials for the current user's credential set and
  supports persistence options:
  [CredWriteW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew).
- `CredReadW` reads from the credential set associated with the current logon
  token and returns an allocated buffer that must be released with `CredFree`:
  [CredReadW](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw).
- PowerShell can compile a small in-memory interop type with
  [`Add-Type`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/add-type).
- [`Invoke-RestMethod`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-restmethod?view=powershell-5.1)
  accepts custom headers, allowing the Authorization header to remain inside
  the same process that read the credential.
- [`cmdkey`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmdkey)
  is unsuitable as the retrieval mechanism: it does not retrieve generic
  credential blobs and accepts passwords through command-line arguments.
- Microsoft documents [`Read-Host -AsSecureString`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/read-host)
  for masked local entry, and warns against plaintext secret handling in
  command-line history and logs:
  [`ConvertTo-SecureString`](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/convertto-securestring).

## Implications for the skill

1. Normalize the host before deriving the target name.
2. Never print, return, serialize, or interpolate the token into a command
   line, transcript, issue, prompt, or diagnostic.
3. Prefer a single PowerShell process that reads the generic credential,
   constructs the Authorization header, calls Prism, and emits only redacted
   status/request metadata.
4. Treat a missing credential as an actionable setup error, not as permission
   to request the token in chat.
5. Keep the fallback secret-file path separate from the repository and require
   the user to create it; do not write the token automatically.
