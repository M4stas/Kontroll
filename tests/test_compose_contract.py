from pathlib import Path

import yaml


def test_compose_is_three_private_tier_services_with_one_public_port():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert set(services) == {"api", "worker", "storage", "worker-chromium"}
    assert "ports" in services["api"]
    assert all("ports" not in services[name] for name in ("worker", "worker-chromium", "storage"))
    assert "turso_data" in compose["volumes"]
    assert "turso_data:/data" in services["storage"]["volumes"]
    assert all("volumes" not in services[name] for name in ("api", "worker", "worker-chromium"))


def test_compose_gates_startup_and_keeps_database_and_keys_private():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert services["storage"]["healthcheck"]["test"]
    assert services["api"]["healthcheck"]["test"]
    assert services["api"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert all(services[name]["restart"] for name in services)
    assert "TURSO_DB_PATH" in services["storage"]["environment"]
    assert "TURSO_DB_PATH" not in services["api"].get("environment", {})
    assert "TURSO_DB_PATH" not in services["worker"].get("environment", {})
    assert "PUBLIC_API_KEY" in services["api"]["environment"]
    assert all("INTERNAL_API_KEY" in services[name]["environment"] for name in services)
    assert all("STORAGE_URL" in services[name]["environment"] for name in ("api", "worker", "worker-chromium"))
    assert "redis" not in str(compose).lower()
    assert "turso_database_url" not in str(compose).lower()
    assert "turso_auth_token" not in str(compose).lower()


def test_services_build_with_captcha_solver_context():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    for name, service in services.items():
        if name == "worker-chromium":
            assert set(service["build"]["additional_contexts"]) == {"browser_assets"}
            continue
        assert "captcha_solver" in service["build"]["additional_contexts"], name


def test_worker_defaults_to_production_env():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker"]
    assert worker["environment"]["AUTO24_ENV"] == "${AUTO24_ENV:-production}"
    assert worker["environment"]["REVEAL_FORCE_FAILURE"] == "${REVEAL_FORCE_FAILURE:-false}"


def _volume_target(volume: str) -> str:
    """Container path of a short-form volume; the source may be ${VAR:?msg}."""
    rest = volume.rsplit("}", 1)[1] if volume.startswith("${") else volume.split(":", 1)[1]
    target = rest.removeprefix(":")
    for mode in (":ro", ":rw"):
        target = target.removesuffix(mode)
    return target


def test_volume_target_handles_variable_sources():
    assert _volume_target("${SANDBOX_DEBUG_DIR:?set it}:/debug") == "/debug"
    assert _volume_target("${X:-a:b}:/reports:ro") == "/reports"
    assert _volume_target("./src:/app/src:ro") == "/app/src"


def test_sandbox_capture_cannot_reach_the_traffic_log():
    services = yaml.safe_load(Path("compose.sandbox.yaml").read_text())["services"]
    assert any(v.endswith(":/reports") for v in services["netlog"]["volumes"])
    targets = [_volume_target(v) for v in services["capture"]["volumes"]]
    assert targets and all(t.startswith("/") for t in targets)
    assert all(not t.startswith("/reports") for t in targets)
    assert "${SANDBOX_REPORT_DIR" not in " ".join(services["capture"]["volumes"])


def test_chromium_worker_uses_the_chromium_image_and_assets():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker-chromium"]
    assert worker["image"] == "auto24-extraction-service:chromium"
    assert "browser_assets" in worker["build"]["additional_contexts"]
    assert worker["environment"]["CAPTURE_ENGINE"] == "chromium"
    assert "chromium" in worker["profiles"]


def test_chromium_worker_has_no_report_or_debug_mounts():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker-chromium"]
    targets = [_volume_target(v) for v in worker.get("volumes", [])]
    assert all(not t.startswith(("/reports", "/debug")) for t in targets)
