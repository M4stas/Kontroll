from pathlib import Path

import yaml


def test_compose_is_three_private_tier_services_with_one_public_port():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert set(services) == {"api", "worker-auto24", "storage", "worker-camoufox", "worker-mnt", "background-checks-init"}
    assert "ports" in services["api"]
    assert all("ports" not in services[name] for name in ("worker-auto24", "worker-camoufox", "worker-mnt", "storage"))
    assert "turso_data" in compose["volumes"]
    assert "turso_data:/data" in services["storage"]["volumes"]
    assert "volumes" not in services["worker-camoufox"]
    assert services["worker-auto24"]["volumes"] == ["background_checks:/data/background-checks"]
    assert services["api"]["volumes"] == ["background_checks:/data/background-checks:ro"]


def test_background_check_pdfs_are_shared_by_the_worker_and_the_api_only():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert "background_checks" in compose["volumes"]
    assert all("background_checks" not in " ".join(services[name].get("volumes", []))
               for name in ("storage", "worker-camoufox"))
    for name in ("api", "worker-auto24"):
        assert services[name]["environment"]["BACKGROUND_CHECK_DIR"] == "/data/background-checks"


def test_compose_gates_startup_and_keeps_database_and_keys_private():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert services["storage"]["healthcheck"]["test"]
    assert services["api"]["healthcheck"]["test"]
    assert services["api"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert services["worker-auto24"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert services["worker-camoufox"]["depends_on"]["storage"]["condition"] == "service_healthy"
    assert all(services[name]["restart"] for name in services if name != "background-checks-init")
    assert "TURSO_DB_PATH" in services["storage"]["environment"]
    assert "TURSO_DB_PATH" not in services["api"].get("environment", {})
    assert "TURSO_DB_PATH" not in services["worker-auto24"].get("environment", {})
    assert "PUBLIC_API_KEY" in services["api"]["environment"]
    assert all("INTERNAL_API_KEY" in services[name]["environment"] for name in services if name != "background-checks-init")
    assert all("STORAGE_URL" in services[name]["environment"] for name in ("api", "worker-auto24", "worker-camoufox"))
    assert "redis" not in str(compose).lower()
    assert "turso_database_url" not in str(compose).lower()
    assert "turso_auth_token" not in str(compose).lower()


def test_services_build_with_captcha_solver_context():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    for name, service in services.items():
        if name == "background-checks-init":
            continue
        if name == "worker-mnt":
            assert service["build"]["dockerfile"] == "Dockerfile.invisible"
            continue
        if name == "worker-auto24":
            assert set(service["build"]["additional_contexts"]) == {"browser_assets"}
            continue
        assert "captcha_solver" in service["build"]["additional_contexts"], name


def test_worker_defaults_to_production_env():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker-auto24"]
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
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker-auto24"]
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
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker-auto24"]
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
    for name in ('storage', 'worker-auto24', 'worker-camoufox'):
        assert services[name]['environment']['LIVE_DIAGNOSTICS_ENABLED'] == '${LIVE_DIAGNOSTICS_ENABLED:-false}'


def test_default_worker_uses_fresh_profiles():
    services = yaml.safe_load(Path('compose.yaml').read_text())['services']
    assert services['worker-auto24']['environment']['CHROMIUM_WARM_PROFILE'] == '${CHROMIUM_WARM_PROFILE:-false}'
    assert all('CHROMIUM_WARM_PROFILE' not in service.get('environment', {})
               for name, service in services.items() if name != 'worker-auto24')


def test_invisible_worker_contract():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    worker = services["worker-mnt"]
    assert "profiles" not in worker  # starts with the default stack
    assert worker["image"] == "auto24-extraction-service:invisible"
    assert worker["volumes"] == services["worker-auto24"]["volumes"]
    assert worker["environment"]["BACKGROUND_CHECK_DIR"] == "/data/background-checks"
    assert worker["environment"]["STORAGE_URL"] == "http://storage:8001"
    assert "INTERNAL_API_KEY" in worker["environment"]
    assert "CAPTURE_ENGINE" not in worker["environment"]
    assert worker["extra_hosts"] == {host: "0.0.0.0" for host in ("api.ipify.org", "icanhazip.com", "checkip.amazonaws.com")}
    init = services["background-checks-init"]
    assert "profiles" not in init
    assert init["image"] == "auto24-extraction-service:invisible"
    assert init["user"] == "0"
    assert init["entrypoint"] == ["chown", "10001:10001", "/data/background-checks"]
    assert init["volumes"] == ["background_checks:/data/background-checks"]
    assert worker["depends_on"]["background-checks-init"]["condition"] == "service_completed_successfully"


def test_invisible_worker_healthcheck_and_chromium_lookup_switch():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    health = services["worker-mnt"]["healthcheck"]
    assert health == {
        **services["worker-auto24"]["healthcheck"],
        "test": ["CMD", "python", "-c", "from pathlib import Path; assert b'auto24_service.lookup_worker' in Path('/proc/1/cmdline').read_bytes()"],
    }
    assert services["worker-auto24"]["environment"]["CHROMIUM_LOOKUPS"] == "${CHROMIUM_LOOKUPS:-false}"


def test_workers_have_plain_container_names():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    assert services["worker-auto24"]["container_name"] == "worker-auto24"
    assert services["worker-mnt"]["container_name"] == "worker-mnt"
