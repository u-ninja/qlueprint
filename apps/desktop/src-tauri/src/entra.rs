//! Microsoft Entra ID access tokens for SQL Server (Azure SQL), one way per sign-in method.
//!
//! Tokens never reach the UI, the saved-connections file or the audit log. An interactive
//! sign-in's refresh token is stored in the OS credential store per saved connection (saved.rs);
//! access tokens stay in memory until shortly before they expire.
//!
//! An interactive sign-in without a Tenant ID asks the server which tenant it trusts, as
//! Microsoft's drivers do: the login's FEDAUTHINFO names the authority and resource
//! (`Authority::from_server`, used by `mssql::Connector`).

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri_plugin_oauth::OauthConfig;

use crate::db::{CommandError, ErrorCode};
use crate::local::process::{self, Cmd, RunError};
use crate::mssql::{MssqlAuth, MssqlServer};

/// Microsoft's public client for its SQL Server drivers (the one DBeaver gets through the JDBC
/// driver). It's pre-authorized for Azure SQL in every tenant, so no admin has to approve it.
/// QluePrint's own registration, 11c0b99a-802a-4e85-a4fa-1dc4546c2d92, needs admin consent per
/// organization until it's publisher-verified; it can be entered as the connection's client ID.
pub(crate) const CLIENT_ID: &str = "7f98cb04-cd1e-40df-9140-3bf7e2cea4db";
/// Any work or school account.
const TENANT: &str = "organizations";
/// Microsoft Entra ID in Azure's public cloud.
const HOST: &str = "https://login.microsoftonline.com";
// The double slash is deliberate: the resource is `https://database.windows.net/`, and Azure SQL
// rejects tokens whose audience lacks that trailing slash ("not configured to accept this token")
const SCOPE: &str = "https://database.windows.net//.default offline_access";
/// Entra's hosts in the public, US government and China clouds: a server's FEDAUTHINFO may only
/// send QluePrint's refresh token to these.
const STS_HOSTS: [&str; 6] = [
    "login.microsoftonline.com",
    "login.windows.net",
    "login.microsoft.com",
    "login.microsoftonline.us",
    "login.chinacloudapi.cn",
    "login.partner.microsoftonline.cn",
];
/// Azure SQL's resource in those clouds: a server may only ask for a token for these, not for
/// another API the account can reach.
const SQL_HOSTS: [&str; 3] = [
    "database.windows.net",
    "database.usgovcloudapi.net",
    "database.chinacloudapi.cn",
];
const RESOURCE: &str = "https://database.windows.net/";
const IMDS: &str = "http://169.254.169.254/metadata/identity/oauth2/token";
/// How long the browser sign-in waits for the user.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(300);
/// A token this close to expiry is replaced before a new connection uses it.
const MARGIN: Duration = Duration::from_secs(300);
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const SIGNED_IN_PAGE: &str = "<html><body style=\"font-family:system-ui;margin:3rem\"><p>You can close this tab and return to QluePrint.</p></body></html>";

/// Refresh tokens from interactive sign-ins this session, by `session_key`: the dialog's
/// "Sign in with Microsoft" leaves one here for the connect that follows, and a refresh keeps
/// the newest.
static SESSIONS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);
/// The loopback port of the browser sign-in in progress, so it can be cancelled.
static SIGN_IN_PORT: Mutex<Option<u16>> = Mutex::new(None);
/// The authority each server named in its FEDAUTHINFO this session, by `server_key`, so later
/// connections and pools send a token up front instead of asking again.
// shortcut: memory only, so the first connect after a restart asks the server again (one extra
// login round trip, then a silent refresh); save it with the connection if that shows up
static DISCOVERED: LazyLock<Mutex<HashMap<String, Authority>>> = LazyLock::new(Mutex::default);
/// Access tokens this session, by `TokenSource::cache_key`, so Test, Connect and each pool share
/// one instead of signing in (or running `az`) again. Memory only.
static TOKENS: LazyLock<Mutex<HashMap<String, Arc<CachedToken>>>> = LazyLock::new(Mutex::default);
/// Held while a token is fetched, so connections opening at once share one sign-in.
type CachedToken = tokio::sync::Mutex<Option<(String, Instant)>>;
/// One HTTP client for Entra and IMDS; its connections are reused.
static AGENT: LazyLock<ureq::Agent> = LazyLock::new(|| {
    ureq::Agent::config_builder()
        // Entra's 400s carry the reason in their JSON body
        .http_status_as_error(false)
        .timeout_global(Some(HTTP_TIMEOUT))
        .build()
        .into()
});

/// Where tokens come from: Entra's host, the tenant, and the scope asked for.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Authority {
    host: String,
    tenant: String,
    scope: String,
}

impl Authority {
    fn public(tenant: &str) -> Self {
        Self {
            host: HOST.into(),
            tenant: tenant.into(),
            scope: SCOPE.into(),
        }
    }

    /// The authority a server's FEDAUTHINFO names: its STS URL is Entra's host and tenant
    /// (`https://login.microsoftonline.com/<tenant>`), its SPN the resource
    /// (`https://database.windows.net/`, scope `https://database.windows.net//.default` as the
    /// JDBC driver and go-mssqldb build it). Errors unless both are Microsoft's.
    pub(crate) fn from_server(sts_url: &str, spn: &str) -> Result<Self, String> {
        let untrusted = || {
            format!(
                "The server asked for a token from {sts_url} for {spn}, which isn’t Microsoft Entra ID and Azure SQL. Set Tenant ID under Advanced to connect anyway."
            )
        };
        let https_host = |text: &str, allowed: &[&str]| {
            url::Url::parse(text).ok().filter(|url| {
                url.scheme() == "https"
                    && url.port().is_none()
                    && url
                        .host_str()
                        .is_some_and(|host| allowed.contains(&host.to_ascii_lowercase().as_str()))
            })
        };
        let sts = https_host(sts_url, &STS_HOSTS).ok_or_else(untrusted)?;
        https_host(spn, &SQL_HOSTS).ok_or_else(untrusted)?;
        let tenant = sts
            .path_segments()
            .and_then(|mut segments| segments.find(|s| !s.is_empty()))
            .ok_or_else(untrusted)?;
        let resource = spn.trim();
        let scope = if resource.ends_with("/.default") {
            format!("{resource} offline_access")
        } else {
            format!("{resource}/.default offline_access")
        };
        Ok(Self {
            host: format!(
                "https://{}",
                sts.host_str().unwrap_or_default().to_ascii_lowercase()
            ),
            tenant: tenant.to_owned(),
            scope,
        })
    }

    /// The OAuth 2.0 v2 endpoints' base.
    fn endpoint(&self) -> String {
        // A tenant is a GUID or a domain; encode anyway so it can't change the path
        let tenant: String = url::form_urlencoded::byte_serialize(self.tenant.as_bytes()).collect();
        format!("{}/{tenant}/oauth2/v2.0", self.host)
    }
}

/// Which server a discovered authority belongs to.
fn server_key(server: &MssqlServer) -> String {
    server.host.trim().to_ascii_lowercase()
}

fn discovered(key: &str) -> Option<Authority> {
    DISCOVERED
        .lock()
        .expect("discovered lock poisoned")
        .get(key)
        .cloned()
}

#[derive(Debug, PartialEq)]
pub(crate) struct Tokens {
    access: String,
    refresh: Option<String>,
    lifetime: Duration,
}

/// What Entra's token endpoint says went wrong.
#[derive(Debug, PartialEq)]
struct OauthError {
    code: String,
    message: String,
}

impl OauthError {
    /// The refresh token is no good any more (expired, revoked, MFA or consent needed again)
    fn needs_sign_in(&self) -> bool {
        matches!(
            self.code.as_str(),
            "invalid_grant" | "interaction_required" | "consent_required" | "login_required"
        )
    }

    fn into_command_error(self, method: &str) -> CommandError {
        // AADSTS50076/50079: MFA is required, which the password grant can't do
        let code = if self.code == "invalid_grant" {
            ErrorCode::InvalidCredentials
        } else {
            ErrorCode::ConnectFailed
        };
        let hint = if self.message.contains("AADSTS50076") || self.message.contains("AADSTS50079") {
            " This account requires MFA: use “Microsoft Entra MFA” instead."
        } else {
            ""
        };
        CommandError::new(code, format!("{method} failed: {}{hint}", self.message))
    }
}

fn tenant_of(server: &MssqlServer) -> &str {
    tenant_id(server).unwrap_or(TENANT)
}

/// The Tenant ID, None when empty.
fn tenant_id(server: &MssqlServer) -> Option<&str> {
    Some(server.tenant_id.trim()).filter(|t| !t.is_empty())
}

/// An interactive sign-in's authority: the Tenant ID, else what the server (by `server_key`)
/// named, else any work or school account.
fn authority(tenant: Option<&str>, server: &str) -> Authority {
    match tenant {
        Some(tenant) => Authority::public(tenant),
        None => discovered(server).unwrap_or_else(|| Authority::public(TENANT)),
    }
}

fn client_of(server: &MssqlServer) -> &str {
    Some(server.client_id.trim())
        .filter(|c| !c.is_empty())
        .unwrap_or(CLIENT_ID)
}

fn session_key(tenant: &str, client: &str, account: &str) -> String {
    format!("{tenant}|{client}|{}", account.trim().to_lowercase())
}

fn sessions() -> std::sync::MutexGuard<'static, HashMap<String, String>> {
    SESSIONS.lock().expect("sessions lock poisoned")
}

/// The newest refresh token for an interactive connection's account, to store with it.
pub(crate) fn refresh_token(server: &MssqlServer) -> Option<String> {
    (server.auth == MssqlAuth::EntraInteractive)
        .then(|| {
            sessions()
                .get(&session_key(
                    &authority(tenant_id(server), &server_key(server)).tenant,
                    client_of(server),
                    &server.user,
                ))
                .cloned()
        })
        .flatten()
}

impl How {
    /// Who a token is for: the method, tenant, client and account or identity. An Entra
    /// password's key has a digest of it, so a mistyped one can't reuse a good one's token.
    fn cache_key(&self) -> String {
        match self {
            How::Interactive {
                tenant,
                server,
                client,
                account,
                ..
            } => format!(
                "interactive|{}|{client}|{}",
                tenant.as_deref().unwrap_or(server),
                account.to_lowercase()
            ),
            How::AzureCli { tenant } => format!("cli|{tenant}"),
            How::ManagedIdentity { client_id } => format!("identity|{client_id}"),
            How::Password {
                tenant,
                client,
                user,
                password,
            } => format!(
                "password|{tenant}|{client}|{}|{}",
                user.to_lowercase(),
                URL_SAFE_NO_PAD.encode(Sha256::digest(password.as_bytes()))
            ),
        }
    }
}

enum How {
    Interactive {
        /// Set from the Tenant ID; otherwise found in `DISCOVERED` under `server`
        tenant: Option<String>,
        server: String,
        client: String,
        account: String,
        /// From the credential store, for a saved connection
        stored: Option<String>,
    },
    AzureCli {
        tenant: String,
    },
    ManagedIdentity {
        client_id: String,
    },
    Password {
        tenant: String,
        client: String,
        user: String,
        password: String,
    },
}

/// Gets access tokens for one connection's pool, reusing one until it's close to expiry.
pub(crate) struct TokenSource {
    how: How,
    /// Shared with every source for the same sign-in (`TOKENS`)
    cached: Arc<CachedToken>,
}

impl TokenSource {
    /// `secret` is the password (Entra password) or the stored refresh token (interactive).
    /// None for a SQL login, which never asks for a token.
    pub(crate) fn new(server: &MssqlServer, secret: &str) -> Option<Self> {
        let tenant = tenant_of(server).to_owned();
        let client = client_of(server).to_owned();
        let how = match server.auth {
            MssqlAuth::SqlLogin => return None,
            MssqlAuth::AzureCli => How::AzureCli {
                tenant: server.tenant_id.trim().to_owned(),
            },
            MssqlAuth::ManagedIdentity => How::ManagedIdentity {
                client_id: server.client_id.trim().to_owned(),
            },
            MssqlAuth::EntraPassword => How::Password {
                tenant,
                client,
                user: server.user.trim().to_owned(),
                password: secret.to_owned(),
            },
            MssqlAuth::EntraInteractive => How::Interactive {
                tenant: tenant_id(server).map(str::to_owned),
                server: server_key(server),
                client,
                account: server.user.trim().to_owned(),
                stored: Some(secret.to_owned()).filter(|s| !s.is_empty()),
            },
        };
        let cached = TOKENS
            .lock()
            .expect("tokens lock poisoned")
            .entry(how.cache_key())
            .or_default()
            .clone();
        Some(Self { how, cached })
    }

    /// Whether a connection has to ask the server for its tenant first: an interactive sign-in
    /// with no Tenant ID and nothing discovered yet.
    pub(crate) fn discovers(&self) -> bool {
        matches!(&self.how, How::Interactive { tenant: None, server, .. } if discovered(server).is_none())
    }

    /// Keeps the authority a server's FEDAUTHINFO names, for this and later connections.
    pub(crate) fn learn(&self, sts_url: &str, spn: &str) -> Result<(), String> {
        let authority = Authority::from_server(sts_url, spn)?;
        if let How::Interactive { server, .. } = &self.how {
            DISCOVERED
                .lock()
                .expect("discovered lock poisoned")
                .insert(server.clone(), authority);
        }
        Ok(())
    }

    pub(crate) async fn token(&self) -> Result<String, CommandError> {
        Ok(self
            .fetch(true)
            .await?
            .expect("a browser sign-in returns a token"))
    }

    /// A token without opening the browser: cached, or from a refresh token. None when only a
    /// browser sign-in would do, or the refresh failed (`token` then says why).
    pub(crate) async fn silent_token(&self) -> Option<String> {
        self.fetch(false).await.ok().flatten()
    }

    async fn fetch(&self, browser: bool) -> Result<Option<String>, CommandError> {
        let mut cached = self.cached.lock().await;
        if let Some((token, expires)) = cached.as_ref()
            && *expires > Instant::now() + MARGIN
        {
            return Ok(Some(token.clone()));
        }
        let tokens = match &self.how {
            How::Interactive {
                tenant,
                server,
                client,
                account,
                stored,
            } => {
                let authority = authority(tenant.as_deref(), server);
                let tokens =
                    interactive(&authority, client, account, stored.as_deref(), browser).await?;
                match tokens {
                    Some(tokens) => tokens,
                    None => return Ok(None),
                }
            }
            How::AzureCli { tenant } => azure_cli(tenant).await?,
            How::ManagedIdentity { client_id } => managed_identity(client_id).await?,
            How::Password {
                tenant,
                client,
                user,
                password,
            } => {
                let form = [
                    ("client_id", client.as_str()),
                    ("grant_type", "password"),
                    ("username", user),
                    ("password", password),
                    ("scope", SCOPE),
                ];
                token_request(&Authority::public(tenant), &form)
                    .await?
                    .map_err(|e| e.into_command_error("Microsoft Entra password sign-in"))?
            }
        };
        *cached = Some((tokens.access.clone(), Instant::now() + tokens.lifetime));
        Ok(Some(tokens.access))
    }
}

/// A refresh with the newest refresh token; a browser sign-in when there's none or it stopped
/// working, unless `browser` is false (then None). The new refresh token is kept for
/// `refresh_token`.
async fn interactive(
    authority: &Authority,
    client: &str,
    account: &str,
    stored: Option<&str>,
    browser: bool,
) -> Result<Option<Tokens>, CommandError> {
    if account.is_empty() {
        return Err(CommandError::new(
            ErrorCode::InvalidInput,
            "Sign in with Microsoft first.",
        ));
    }
    let key = session_key(&authority.tenant, client, account);
    // The dialog's sign-in is for any work or school account; Entra lets its refresh token get a
    // token for another tenant the account is in (a guest's), often without asking again
    let refresh = {
        let sessions = sessions();
        sessions
            .get(&key)
            .or_else(|| sessions.get(&session_key(TENANT, client, account)))
            .cloned()
    }
    .or(stored.map(str::to_owned));
    let refreshed = match refresh {
        Some(refresh) => {
            let form = [
                ("client_id", client),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.as_str()),
                ("scope", authority.scope.as_str()),
            ];
            match token_request(authority, &form).await? {
                Ok(tokens) => Some(tokens),
                Err(e) if e.needs_sign_in() => None,
                Err(e) => return Err(e.into_command_error("Microsoft Entra sign-in")),
            }
        }
        None => None,
    };
    let tokens = match refreshed {
        Some(tokens) => tokens,
        None if browser => browser_sign_in(authority, client, account).await?.0,
        None => return Ok(None),
    };
    if let Some(refresh) = &tokens.refresh {
        sessions().insert(key, refresh.clone());
    }
    Ok(Some(tokens))
}

/// "Sign in with Microsoft" in the connect dialog: the browser flow, keeping the refresh token in
/// memory for the connect that follows, which asks the server for its tenant when `tenant_id` is
/// empty. Returns the account that signed in.
#[tauri::command]
#[specta::specta]
pub async fn entra_sign_in(
    tenant_id: String,
    client_id: String,
    login_hint: String,
) -> Result<String, CommandError> {
    let tenant = Some(tenant_id.trim())
        .filter(|t| !t.is_empty())
        .unwrap_or(TENANT);
    let client = Some(client_id.trim())
        .filter(|c| !c.is_empty())
        .unwrap_or(CLIENT_ID);
    let (tokens, account) =
        browser_sign_in(&Authority::public(tenant), client, login_hint.trim()).await?;
    let Some(account) = account else {
        return Err(CommandError::new(
            ErrorCode::ConnectFailed,
            "Signed in, but Microsoft didn’t say which account. Try again.",
        ));
    };
    if let Some(refresh) = tokens.refresh {
        sessions().insert(session_key(tenant, client, &account), refresh);
    }
    Ok(account)
}

/// Stops a browser sign-in that's waiting (the user closed the tab).
#[tauri::command]
#[specta::specta]
pub fn entra_cancel_sign_in() {
    if let Some(port) = SIGN_IN_PORT.lock().expect("sign-in lock poisoned").take() {
        let _ = tauri_plugin_oauth::cancel(port);
    }
}

/// OAuth 2.0 authorization code with PKCE in the system browser (not a webview: Entra's
/// conditional access and passkeys need the real one), caught on a loopback redirect.
async fn browser_sign_in(
    authority: &Authority,
    client: &str,
    hint: &str,
) -> Result<(Tokens, Option<String>), CommandError> {
    let failed = |e: &dyn std::fmt::Display| {
        CommandError::new(
            ErrorCode::ConnectFailed,
            format!("Couldn’t start the Microsoft sign-in: {e}"),
        )
    };
    let verifier = random_text(32)?;
    let state = random_text(16)?;
    let (sender, mut callback) = tokio::sync::mpsc::unbounded_channel();
    let config = OauthConfig {
        response: Some(SIGNED_IN_PAGE.into()),
        ..Default::default()
    };
    let port = tauri_plugin_oauth::start_with_config(config, move |url| {
        let _ = sender.send(url);
    })
    .map_err(|e| failed(&e))?;
    if let Some(previous) = SIGN_IN_PORT
        .lock()
        .expect("sign-in lock poisoned")
        .replace(port)
    {
        let _ = tauri_plugin_oauth::cancel(previous);
    }
    let redirect = format!("http://localhost:{port}");
    let url = authorize_url(
        authority,
        client,
        &redirect,
        &challenge(&verifier),
        &state,
        hint,
    );
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        entra_cancel_sign_in();
        return Err(failed(&e));
    }
    let url = tokio::time::timeout(SIGN_IN_TIMEOUT, callback.recv()).await;
    entra_cancel_sign_in();
    let url = match url {
        Ok(Some(url)) => url,
        Ok(None) => {
            return Err(CommandError::new(
                ErrorCode::Cancelled,
                "Microsoft sign-in was cancelled.",
            ));
        }
        Err(_) => {
            return Err(CommandError::new(
                ErrorCode::Cancelled,
                "Microsoft sign-in timed out. Try again.",
            ));
        }
    };
    let code = callback_code(&url, &state)?;
    let form = [
        ("client_id", client),
        ("grant_type", "authorization_code"),
        ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()),
        ("code_verifier", verifier.as_str()),
        ("scope", authority.scope.as_str()),
    ];
    let tokens = token_request(authority, &form)
        .await?
        .map_err(|e| e.into_command_error("Microsoft Entra sign-in"))?;
    let account = account_of(&tokens.access);
    Ok((tokens, account))
}

/// `bytes` random bytes as base64url, for the PKCE verifier and the state.
fn random_text(bytes: usize) -> Result<String, CommandError> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| {
        CommandError::new(
            ErrorCode::ConnectFailed,
            format!("No secure random numbers: {e}"),
        )
    })?;
    Ok(URL_SAFE_NO_PAD.encode(buf))
}

/// PKCE S256: base64url(SHA-256(verifier)).
fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn authorize_url(
    authority: &Authority,
    client: &str,
    redirect: &str,
    challenge: &str,
    state: &str,
    hint: &str,
) -> url::Url {
    let mut url = url::Url::parse(&format!("{}/authorize", authority.endpoint()))
        .expect("the authority is a valid URL");
    url.query_pairs_mut()
        .append_pair("client_id", client)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect)
        .append_pair("response_mode", "query")
        .append_pair("scope", &authority.scope)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("prompt", "select_account");
    if !hint.is_empty() {
        url.query_pairs_mut().append_pair("login_hint", hint);
    }
    url
}

/// The authorization code from the redirect, once its state matches ours.
fn callback_code(url: &str, state: &str) -> Result<String, CommandError> {
    let fail = |message: String| CommandError::new(ErrorCode::ConnectFailed, message);
    let url =
        url::Url::parse(url).map_err(|e| fail(format!("Unreadable sign-in redirect: {e}")))?;
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    if param("state").as_deref() != Some(state) {
        return Err(fail(
            "The sign-in response doesn’t belong to this sign-in. Try again.".into(),
        ));
    }
    if let Some(error) = param("error") {
        let description = param("error_description").unwrap_or(error);
        return Err(fail(format!(
            "Microsoft sign-in failed: {}",
            first_line(&description)
        )));
    }
    param("code").ok_or_else(|| fail("The sign-in response has no code.".into()))
}

fn first_line(text: &str) -> &str {
    text.lines().next().unwrap_or(text).trim()
}

/// The account in an access token (upn, else preferred_username…), for display and as the
/// connection's user. Read only, never trusted: the database checks the token itself.
fn account_of(access_token: &str) -> Option<String> {
    let payload = access_token.split('.').nth(1)?;
    let json = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&json).ok()?;
    ["upn", "preferred_username", "unique_name", "email"]
        .iter()
        .find_map(|claim| claims[claim].as_str())
        .map(str::to_owned)
}

/// A token response: Entra's (`expires_in` seconds), IMDS's (the same as text) or the Azure
/// CLI's (`accessToken`, `expires_on` Unix time).
fn parse_tokens(body: &str) -> Result<Tokens, OauthError> {
    let unreadable = || OauthError {
        code: "unreadable".into(),
        message: "the response wasn’t a token".into(),
    };
    let v: Value = serde_json::from_str(body).map_err(|_| unreadable())?;
    let text = |key: &str| v[key].as_str().map(str::to_owned);
    let number = |key: &str| {
        v[key]
            .as_u64()
            .or_else(|| v[key].as_str().and_then(|s| s.parse().ok()))
    };
    if let Some(code) = text("error") {
        let message = text("error_description").unwrap_or_else(|| code.clone());
        return Err(OauthError {
            message: first_line(&message).to_owned(),
            code,
        });
    }
    let access = text("access_token")
        .or_else(|| text("accessToken"))
        .ok_or_else(unreadable)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let seconds = number("expires_in")
        .or_else(|| number("expires_on").map(|at| at.saturating_sub(now)))
        // Entra's tokens last at least an hour
        .unwrap_or(3600);
    Ok(Tokens {
        access,
        refresh: text("refresh_token"),
        lifetime: Duration::from_secs(seconds),
    })
}

fn http_failed(what: &str, e: impl std::fmt::Display) -> CommandError {
    CommandError::new(
        ErrorCode::ConnectFailed,
        format!("Couldn’t reach {what}: {e}"),
    )
}

/// POSTs `form` to the tenant's token endpoint (blocking I/O, so on Tokio's blocking pool).
async fn token_request(
    authority: &Authority,
    form: &[(&str, &str)],
) -> Result<Result<Tokens, OauthError>, CommandError> {
    let url = format!("{}/token", authority.endpoint());
    let host = authority.host.trim_start_matches("https://").to_owned();
    let form: Vec<(String, String)> = form
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect();
    let body = tokio::task::spawn_blocking(move || {
        AGENT
            .post(&url)
            .send_form(form.iter().map(|(k, v)| (k.as_str(), v.as_str())))
            .and_then(|mut response| response.body_mut().read_to_string())
    })
    .await
    .expect("the token request doesn't panic")
    .map_err(|e| http_failed(&format!("Microsoft Entra ID ({host})"), e))?;
    Ok(parse_tokens(&body))
}

/// The token Azure's instance metadata service gives this machine's managed identity.
async fn managed_identity(client_id: &str) -> Result<Tokens, CommandError> {
    let client_id = client_id.to_owned();
    let not_on_azure = || {
        CommandError::new(
            ErrorCode::ConnectFailed,
            "Managed identity only works when QluePrint runs on an Azure VM or App Service.",
        )
    };
    let body = tokio::task::spawn_blocking(move || {
        let mut request = AGENT
            .get(IMDS)
            .config()
            .timeout_global(Some(Duration::from_secs(5)))
            .build()
            .query("api-version", "2018-02-01")
            .query("resource", RESOURCE)
            .header("Metadata", "true");
        if !client_id.is_empty() {
            request = request.query("client_id", &client_id);
        }
        request
            .call()
            .and_then(|mut response| response.body_mut().read_to_string())
    })
    .await
    .expect("the metadata request doesn't panic")
    .map_err(|_| not_on_azure())?;
    parse_tokens(&body).map_err(|e| e.into_command_error("Managed identity"))
}

/// `az account get-access-token`, which signs in as whoever ran `az login`.
async fn azure_cli(tenant: &str) -> Result<Tokens, CommandError> {
    let extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        r"C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin",
        r"C:\Program Files (x86)\Microsoft SDKs\Azure\CLI2\wbin",
    ]
    .map(std::path::PathBuf::from);
    let not_installed = || {
        CommandError::new(
            ErrorCode::ConnectFailed,
            "The Azure CLI (az) isn’t installed. Install it, run “az login”, then connect again.",
        )
    };
    let az = process::find_program("az", &extra).ok_or_else(not_installed)?;
    let mut args = [
        "account",
        "get-access-token",
        "--resource",
        RESOURCE,
        "--output",
        "json",
    ]
    .map(str::to_owned)
    .to_vec();
    if !tenant.is_empty() {
        args.extend(["--tenant".to_owned(), tenant.to_owned()]);
    }
    let cmd = Cmd {
        program: az,
        args,
        env: Vec::new(),
        stdin: None,
        timeout: Duration::from_secs(60),
    };
    let output = process::output(&cmd).await.map_err(|e| match e {
        RunError::NotFound => not_installed(),
        RunError::TimedOut => CommandError::new(
            ErrorCode::ConnectFailed,
            "The Azure CLI didn’t answer within a minute.",
        ),
        RunError::Io(e) => http_failed("the Azure CLI", e),
        RunError::Cancelled => http_failed("the Azure CLI", "cancelled"),
    })?;
    if !output.success {
        let stderr = &output.stderr;
        let message = if stderr.contains("az login") {
            "The Azure CLI isn’t signed in. Run “az login” in a terminal, then connect again."
                .to_owned()
        } else {
            format!(
                "The Azure CLI couldn’t get a token: {}",
                first_line(stderr.trim_start_matches("ERROR: "))
            )
        };
        return Err(CommandError::new(ErrorCode::ConnectFailed, message));
    }
    parse_tokens(&output.stdout).map_err(|e| e.into_command_error("The Azure CLI"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_rfc_7636_example() {
        // RFC 7636 appendix B
        assert_eq!(
            challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
        let verifier = random_text(32).unwrap();
        // 43 characters: the shortest verifier RFC 7636 allows
        assert_eq!(verifier.len(), 43);
        assert_ne!(verifier, random_text(32).unwrap());
    }

    #[test]
    fn builds_the_authorize_url() {
        let url = authorize_url(
            &Authority::public("contoso.onmicrosoft.com"),
            CLIENT_ID,
            "http://localhost:51234",
            "abc",
            "xyz",
            "ada@contoso.com",
        );
        assert_eq!(
            url.as_str().split('?').next(),
            Some("https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize")
        );
        let pairs: HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], CLIENT_ID);
        assert_eq!(pairs["redirect_uri"], "http://localhost:51234");
        assert_eq!(pairs["scope"], SCOPE);
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["login_hint"], "ada@contoso.com");
        // A tenant can't reach into the path
        assert!(
            Authority::public("a/../b")
                .endpoint()
                .ends_with("/a%2F..%2Fb/oauth2/v2.0")
        );
    }

    #[test]
    fn takes_the_authority_from_the_server() {
        let tenant = "68481c17-4a16-4490-a65b-8476b2d93235";
        let sql = "https://database.windows.net/";
        let public =
            Authority::from_server(&format!("https://login.microsoftonline.com/{tenant}/"), sql)
                .unwrap();
        assert_eq!(
            public,
            Authority {
                host: "https://login.microsoftonline.com".into(),
                tenant: tenant.into(),
                // The SPN's trailing slash plus /.default, as the drivers build it
                scope: "https://database.windows.net//.default offline_access".into(),
            }
        );
        assert_eq!(public.scope, SCOPE);
        assert_eq!(
            public.endpoint(),
            format!("https://login.microsoftonline.com/{tenant}/oauth2/v2.0")
        );
        // No trailing slash, a domain tenant, the older host
        let older =
            Authority::from_server("https://login.windows.net/contoso.onmicrosoft.com", sql)
                .unwrap();
        assert_eq!(
            (older.host.as_str(), older.tenant.as_str()),
            ("https://login.windows.net", "contoso.onmicrosoft.com")
        );
        // Sovereign clouds keep their own host and resource
        let us = Authority::from_server(
            &format!("https://login.microsoftonline.us/{tenant}"),
            "https://database.usgovcloudapi.net/",
        )
        .unwrap();
        assert_eq!(us.host, "https://login.microsoftonline.us");
        assert_eq!(
            us.scope,
            "https://database.usgovcloudapi.net//.default offline_access"
        );
        let cn = Authority::from_server(
            &format!("https://login.chinacloudapi.cn/{tenant}/"),
            "https://database.chinacloudapi.cn/.default",
        )
        .unwrap();
        assert_eq!(cn.host, "https://login.chinacloudapi.cn");
        assert_eq!(
            cn.scope,
            "https://database.chinacloudapi.cn/.default offline_access"
        );
        assert!(
            cn.endpoint()
                .starts_with("https://login.chinacloudapi.cn/68481c17-")
        );
    }

    #[test]
    fn sends_tokens_only_to_microsoft() {
        let sql = "https://database.windows.net/";
        for sts in [
            "https://evil.example/tenant",
            "http://login.microsoftonline.com/tenant",
            "https://login.microsoftonline.com.evil.example/tenant",
            "https://login.microsoftonline.com:8443/tenant",
            "https://login.microsoftonline.com/",
            "not a url",
        ] {
            assert!(Authority::from_server(sts, sql).is_err(), "{sts}");
        }
        // Nor a token for another API the account can reach
        let sts = "https://login.microsoftonline.com/tenant";
        assert!(Authority::from_server(sts, "https://graph.microsoft.com/").is_err());
        assert!(Authority::from_server(sts, "https://database.windows.net.evil.example/").is_err());
    }

    #[test]
    fn reads_the_redirect() {
        let ok = "http://localhost:5000/?code=0.AX&state=s1&session_state=x";
        assert_eq!(callback_code(ok, "s1").unwrap(), "0.AX");
        assert!(callback_code(ok, "other").is_err());
        let denied = "http://localhost:5000/?error=access_denied&error_description=AADSTS65004%3A+User+declined.%0D%0ATrace+ID%3A+1&state=s1";
        assert_eq!(
            callback_code(denied, "s1").unwrap_err().message(),
            "Microsoft sign-in failed: AADSTS65004: User declined."
        );
    }

    #[test]
    fn parses_token_responses() {
        let entra = r#"{"token_type":"Bearer","scope":"https://database.windows.net/user_impersonation","expires_in":4209,"access_token":"a.b.c","refresh_token":"r1"}"#;
        assert_eq!(
            parse_tokens(entra).unwrap(),
            Tokens {
                access: "a.b.c".into(),
                refresh: Some("r1".into()),
                lifetime: Duration::from_secs(4209)
            }
        );
        // IMDS writes numbers as text
        let imds = r#"{"access_token":"t","expires_in":"3599","resource":"https://database.windows.net/"}"#;
        assert_eq!(
            parse_tokens(imds).unwrap().lifetime,
            Duration::from_secs(3599)
        );
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let cli = format!(
            r#"{{"accessToken":"t2","expiresOn":"2030-01-01 10:00:00.000000","expires_on":{},"tokenType":"Bearer"}}"#,
            now + 1800
        );
        let cli = parse_tokens(&cli).unwrap();
        assert_eq!((cli.access.as_str(), cli.refresh), ("t2", None));
        assert!(cli.lifetime.as_secs().abs_diff(1800) < 5);

        let error = r#"{"error":"invalid_grant","error_description":"AADSTS700082: The refresh token has expired.\r\nTrace ID: 1\r\nCorrelation ID: 2"}"#;
        let error = parse_tokens(error).unwrap_err();
        assert!(error.needs_sign_in());
        assert_eq!(
            error.message,
            "AADSTS700082: The refresh token has expired."
        );
        assert!(parse_tokens("<html>").is_err());
    }

    #[test]
    fn reads_the_account_without_trusting_the_token() {
        let claims = URL_SAFE_NO_PAD
            .encode(br#"{"aud":"https://database.windows.net/","upn":"ada@contoso.com"}"#);
        assert_eq!(
            account_of(&format!("eyJhbGciOiJub25lIn0.{claims}.sig")).as_deref(),
            Some("ada@contoso.com")
        );
        assert_eq!(account_of("not-a-jwt"), None);
    }
}
