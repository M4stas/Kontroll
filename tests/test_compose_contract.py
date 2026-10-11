from pathlib import Path

import yaml


def test_compose_is_three_private_tier_services_with_one_public_port():
    compose = yaml.safe_load(Path("compose.yaml").read_text())
    services = compose["services"]
    assert set(services) == {"api", "worker", "storage"}
    assert "ports" in services["api"]
    assert all("ports" not in services[name] for name in ("worker", "storage"))
    assert "turso_data" in compose["volumes"]
    assert "turso_data:/data" in services["storage"]["volumes"]
    assert all("volumes" not in services[name] for name in ("api", "worker"))


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
    assert all("STORAGE_URL" in services[name]["environment"] for name in ("api", "worker"))
    assert "redis" not in str(compose).lower()
    assert "turso_database_url" not in str(compose).lower()
    assert "turso_auth_token" not in str(compose).lower()


def test_services_build_with_captcha_solver_context():
    services = yaml.safe_load(Path("compose.yaml").read_text())["services"]
    for name, service in services.items():
        assert "captcha_solver" in service["build"]["additional_contexts"], name


def test_worker_defaults_to_production_env():
    worker = yaml.safe_load(Path("compose.yaml").read_text())["services"]["worker"]
    assert worker["environment"]["AUTO24_ENV"] == "${AUTO24_ENV:-production}"
    assert worker["environment"]["REVEAL_FORCE_FAILURE"] == "${REVEAL_FORCE_FAILURE:-false}"
