import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_SOURCE = REPOSITORY_ROOT / ".agents" / "skills" / "prism-slack" / "scripts" / "setup_credentials.py"


class SetupCredentialsTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="prism-skill-test-"))
        self.skill_root = self.temp_dir / ".agents" / "skills" / "prism-slack"
        scripts = self.skill_root / "scripts"
        scripts.mkdir(parents=True)
        script = scripts / "setup_credentials.py"
        shutil.copyfile(SCRIPT_SOURCE, script)
        spec = importlib.util.spec_from_file_location("setup_credentials_test_module", script)
        self.module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = self.module
        spec.loader.exec_module(self.module)

    def tearDown(self):
        shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_config_path_is_relative_to_installed_skill(self):
        self.assertEqual(self.module.skill_config_path(), self.skill_root / "config.json")

    def test_marker_is_atomic_non_secret_metadata(self):
        self.module._write_configuration_marker("https://prism.example")
        config = json.loads((self.skill_root / "config.json").read_text(encoding="utf-8"))

        self.assertEqual(config["origin"], "https://prism.example:443")
        self.assertTrue(config["configured"])
        self.assertIn("verifiedAt", config)
        self.assertNotIn("prism_dev_", json.dumps(config))
        self.assertFalse(any(self.skill_root.glob("*.tmp")))

    def test_origin_change_requires_confirmation_and_preserves_existing_file(self):
        self.module._write_configuration_marker("https://old.example")
        path = self.skill_root / "config.json"
        original = path.read_bytes()

        with self.assertRaises(self.module.PrismCredentialError):
            self.module._write_configuration_marker("https://new.example")

        self.assertEqual(path.read_bytes(), original)
        self.module._write_configuration_marker("https://new.example", confirm_origin_change=True)
        self.assertEqual(self.module.read_configuration_marker()["origin"], "https://new.example:443")

    def test_environment_mismatch_does_not_mutate_environment(self):
        env = {"PRISM_BASE_URL": "https://other.example"}

        mismatch = self.module.environment_origin_mismatch("https://prism.example", env)

        self.assertEqual(mismatch, ("https://prism.example:443", "https://other.example:443"))
        self.assertEqual(env["PRISM_BASE_URL"], "https://other.example")

        invalid = self.module.environment_origin_mismatch("https://prism.example", {"PRISM_BASE_URL": "10.62.240.10"})
        self.assertEqual(invalid, ("https://prism.example:443", None))

    def test_setup_checks_origin_and_environment_before_prompting(self):
        self.module._write_configuration_marker("https://old.example")

        with patch.dict(self.module.os.environ, {"PRISM_BASE_URL": "https://other.example"}, clear=False):
            with patch.object(self.module, "_prompt_for_token", side_effect=AssertionError("token prompt was reached")):
                with self.assertRaises(self.module.PrismCredentialError) as error:
                    self.module.setup_credentials("https://new.example")

        self.assertIn("already points to https://old.example:443", str(error.exception))

    def test_confirmed_origin_change_can_replace_invalid_config(self):
        path = self.skill_root / "config.json"
        path.write_text("not-json", encoding="utf-8")

        self.module._write_configuration_marker("https://new.example", confirm_origin_change=True)

        self.assertEqual(self.module.read_configuration_marker()["origin"], "https://new.example:443")

    def test_invalid_origin_config_requires_confirmation_before_replacement(self):
        path = self.skill_root / "config.json"
        path.write_text("not-json", encoding="utf-8")

        with self.assertRaises(self.module.PrismCredentialError) as error:
            self.module._write_configuration_marker("https://new.example")

        self.assertIn("--confirm-origin-change", str(error.exception))
        self.assertEqual(path.read_text(encoding="utf-8"), "not-json")

    def test_missing_stored_credential_is_detected_structurally(self):
        backend = MagicMock()
        with patch.object(self.module, "_select_backend", return_value=backend):
            with patch.object(
                self.module,
                "_read_token",
                side_effect=self.module.CredentialNotFoundError("different wording"),
            ):
                self.assertFalse(self.module._has_stored_credential("https://prism.example"))

    def test_missing_fallback_credential_is_detected_structurally(self):
        backend = object.__new__(self.module._WindowsCredentialBackend)
        with patch.object(self.module, "_select_backend", return_value=backend):
            with patch.object(
                self.module,
                "_read_token",
                side_effect=[
                    self.module.CredentialNotFoundError("native credential missing"),
                    self.module.CredentialNotFoundError("fallback credential missing"),
                ],
            ):
                self.assertFalse(
                    self.module._has_stored_credential("https://prism.example", allow_file_fallback=True)
                )

    def test_invalid_stored_credential_requires_explicit_replacement(self):
        with patch.dict(self.module.os.environ, {}, clear=True):
            with patch.object(self.module, "_has_stored_credential", return_value=True):
                with patch.object(
                    self.module,
                    "record_verified_origin",
                    side_effect=self.module.PrismCredentialError("not ready"),
                ):
                    with patch.object(self.module, "_prompt_for_token", side_effect=AssertionError("prompted")):
                        with self.assertRaises(self.module.PrismCredentialError) as error:
                            self.module.setup_credentials("https://prism.example")

        self.assertIn("--replace", str(error.exception))

    def test_invalid_environment_origin_requires_confirmation(self):
        with patch.dict(self.module.os.environ, {"PRISM_BASE_URL": "10.62.240.10"}, clear=True):
            with patch.object(self.module, "_has_stored_credential", side_effect=AssertionError("checked credentials")):
                with self.assertRaises(self.module.PrismCredentialError) as error:
                    self.module.setup_credentials("https://prism.example")

        self.assertIn("invalid value", str(error.exception))
        self.assertIn("--confirm-environment-origin", str(error.exception))

    def test_explicit_replacement_prompts_and_stores_new_credential(self):
        backend = MagicMock()
        response = self.module.SafeResponse(status=200, ok=True, data={"token": {"valid": True}}, headers={})
        with patch.dict(self.module.os.environ, {}, clear=True):
            with patch.object(self.module, "_has_stored_credential", return_value=True):
                with patch.object(self.module, "_prompt_for_token", return_value="prism_dev_replacement"):
                    with patch.object(self.module, "request", return_value=response):
                        with patch.object(self.module, "_select_backend", return_value=backend):
                            with patch.object(self.module, "record_verified_origin", return_value="verified"):
                                result = self.module.setup_credentials("https://prism.example", replace_existing=True)

        self.assertEqual(result, response)
        backend._write.assert_called_once_with("Prism/prism.example/developer-token", "prism_dev_replacement")

    def test_setup_reuses_a_stored_credential_without_prompting_again(self):
        with patch.dict(self.module.os.environ, {}, clear=True):
            with patch.object(self.module, "_has_stored_credential", return_value=True):
                with patch.object(self.module, "record_verified_origin", return_value="verified"):
                    with patch.object(self.module, "_prompt_for_token", side_effect=AssertionError("token prompt was reached")):
                        result = self.module.setup_credentials("https://prism.example")

        self.assertEqual(result, "verified")


if __name__ == "__main__":
    unittest.main()
