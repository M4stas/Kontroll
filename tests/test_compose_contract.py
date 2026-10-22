from pathlib import Path

import yaml


def test_compose_is_three_private_tier_services_with_one_public_port():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert set(services) == {"api", "worker", "storage", "worker-camoufox"}
    assert "ports" in services["api"]
    assert all("ports" not in services[name] for name in ("worker", "worker-camoufox", "storage"))
    assert "turso_data" in compose["volumes"]
    assert "turso_data:/data" in services["storage"]["volumes"]
    assert "volumes" not in services["worker-camoufox"]
    assert services["worker"]["volumes"] == ["background_checks:/data/background-checks"]
    assert services["api"]["volumes"] == ["background_checks:/data/background-checks:ro"]


def test_background_check_pdfs_are_shared_by_the_worker_and_the_api_only():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert "background_checks" in compose["volumes"]
    assert all("background_checks" not in " ".join(services[name].get("volumes", []))
               for name in ("storage", "worker-camoufox"))
    for name in ("api", "worker"):
        assert services[name]["environment"]["BACKGROUND_CHECK_DIR"] == "/data/background-checks"


def test_compose_gates_startup_and_keeps_database_and_keys_private():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert services["storage"]["healthcheck"]["test"]
    assert services["api"]["healthcheck"]["test"]
    assert services["api"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert services["worker"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert services["worker-camoufox"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert all(services[name]["restart"] for name in services)
    assert "TURSO_DB_PATH" in services["storage"]["environment"]
    assert "TURSO_DB_PATH" not in services["api"].get("environment", {})
    assert "TURSO_DB_PATH" not in services["worker"].get("environment", {})
    assert "PUBLIC_API_KEY" in services["api"]["environment"]
    assert all("INTERNAL_API_KEY" in services[name]["environment"] for name in services)
    assert all("STORAGE_URL" in services[name]["environment"] for name in ("api", "worker", "worker-camoufox"))
    assert "redis" not in str(compose).lower()
    assert "turso_database_url" not in str(compose).lower()
    assert "turso_auth_token" not in str(compose).lower()


def test_services_build_with_captcha_solver_context():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    for name, service in services.items():
        if name == "worker":
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


def test_default_worker_runs_chromium():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker"]
    assert worker["image"] == "auto24-extraction-service:chromium"
    assert worker["build"]["dockerfile"] == "Dockerfile.chromium"
    assert "browser_assets" in worker["build"]["additional_contexts"]
    assert worker["environment"]["CAPTURE_ENGINE"] == "${CAPTURE_ENGINE:-chromium}"
    assert worker["environment"]["CHROMIUM_HEADLESS"] == "${CHROMIUM_HEADLESS:-false}"
    assert "profiles" not in worker


def test_camoufox_worker_is_opt_in():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    assert "worker-chromium" not in services
    worker = services["worker-camoufox"]
    assert worker["profiles"] == ["camoufox"]
    assert worker["image"] == "auto24-extraction-service:compose"
    assert "captcha_solver" in worker["build"]["additional_contexts"]
    assert worker["environment"]["CAPTURE_ENGINE"] == "camoufox"


def test_default_worker_has_no_report_or_debug_mounts():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker"]
    targets = [_volume_target(v) for v in worker.get("volumes", [])]
    assert all(not t.startswith(("/reports", "/debug")) for t in targets)


def test_sandbox_chromium_capture_has_no_reports_mount():
    service = yaml.safe_load(Path("compose.sandbox.yaml").read_text())["services"]["capture-chromium"]
    assert service["image"] == "auto24-extraction-service:chromium"
    assert service["network_mode"] == "service:netlog"
    assert all(not _volume_target(v).startswith("/reports") for v in service["volumes"])
    assert "${SANDBOX_REPORT_DIR" not in " ".join(service["volumes"])


def test_compose_passes_diagnostics_flag_to_storage_and_worker():
    services = yaml.safe_load(Path('compose.yaml').read_text())['services']
    for name in ('storage', 'worker', 'worker-camoufox'):
        assert services[name]['environment']['LIVE_DIAGNOSTICS_ENABLED'] == '${LIVE_DIAGNOSTICS_ENABLED:-false}'


def test_default_worker_uses_fresh_profiles():
    services = yaml.safe_load(Path('compose.yaml').read_text())['services']
    assert services['worker']['environment']['CHROMIUM_WARM_PROFILE'] == '${CHROMIUM_WARM_PROFILE:-false}'
    assert all('CHROMIUM_WARM_PROFILE' not in service.get('environment', {})
               for name, service in services.items() if name != 'worker')
