"""Auth surface health checks — /api/auth/google, /auth/google-redirect,
/auth/apple, /auth/me. Verifies endpoints are alive and return controlled
error responses (not 500s) after the sign-in surface refactor."""
import os
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://hyperlocal-video.preview.emergentagent.com").rstrip("/")
TEST_TOKEN = os.environ.get("TEST_SESSION_TOKEN", "sttest_SnTv9X5GmiggyZq5vKriLEqtcFmSMN4s")


@pytest.fixture
def client():
    s = requests.Session()
    return s


class TestBuildStamp:
    def test_root_build_stamp(self, client):
        r = client.get(f"{BASE_URL}/api/")
        assert r.status_code == 200
        body = r.json()
        # Log build info
        print(f"Root response: {body}")
        # Not asserting exact stamp — just that endpoint alive
        assert isinstance(body, dict)


class TestGoogleAuth:
    def test_google_invalid_credential_returns_401(self, client):
        r = client.post(f"{BASE_URL}/api/auth/google", json={"credential": "not-a-real-jwt"})
        assert r.status_code == 401, f"Expected 401, got {r.status_code}: {r.text}"
        body = r.json()
        assert body.get("detail") == "Invalid Google credential", f"Unexpected body: {body}"

    def test_google_missing_credential_returns_422(self, client):
        r = client.post(f"{BASE_URL}/api/auth/google", json={})
        assert r.status_code == 422

    def test_google_redirect_invalid_credential_303(self, client):
        # Form-encoded POST, do not follow redirect
        r = client.post(
            f"{BASE_URL}/api/auth/google-redirect",
            data={"credential": "not-a-real-jwt"},
            allow_redirects=False,
        )
        # Should be 303 redirect back to / with auth_error, not 500
        assert r.status_code == 303, f"Expected 303, got {r.status_code}: {r.text[:200]}"
        loc = r.headers.get("location", "")
        assert "auth_error=invalid_credential" in loc, f"Unexpected redirect: {loc}"

    def test_google_redirect_missing_credential_422(self, client):
        r = client.post(
            f"{BASE_URL}/api/auth/google-redirect",
            data={},
            allow_redirects=False,
        )
        # Missing required form field
        assert r.status_code == 422, f"Expected 422, got {r.status_code}"


class TestAppleAuth:
    def test_apple_invalid_id_token_returns_401(self, client):
        r = client.post(f"{BASE_URL}/api/auth/apple", json={"id_token": "not-a-real-apple-jwt"})
        assert r.status_code == 401, f"Expected 401, got {r.status_code}: {r.text}"


class TestAuthMe:
    def test_me_no_credentials_returns_401(self, client):
        r = client.get(f"{BASE_URL}/api/auth/me")
        assert r.status_code == 401, f"Expected 401, got {r.status_code}: {r.text}"

    def test_me_with_bearer_returns_user(self, client):
        r = client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": f"Bearer {TEST_TOKEN}"},
        )
        assert r.status_code == 200, f"Expected 200 with valid token, got {r.status_code}: {r.text}"
        body = r.json()
        assert "user" in body
        assert "onboarded" in body
        user = body["user"]
        assert "id" in user
        assert "email" in user
        print(f"QA user: {user.get('email')} id={user.get('id')}")

    def test_me_with_invalid_bearer_returns_401(self, client):
        r = client.get(
            f"{BASE_URL}/api/auth/me",
            headers={"Authorization": "Bearer totally-invalid-token"},
        )
        assert r.status_code == 401
