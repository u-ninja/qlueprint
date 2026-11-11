# QueryCraft's patch to tiberius 0.13.0

This is tiberius 0.13.0 from crates.io (`.cargo_vcs_info.json` has the upstream commit), used through
`[patch.crates-io]` in `../../Cargo.toml`. Left out of the copy: `.github`, `.envrc`, `.editorconfig`,
`.gitleaks.toml`, `docs`, `flake.*`, `docker-compose.yml`, `rust-toolchain`. The manifest's example and
test targets are kept, and so is `docker/certs`, which the unit tests read. Every changed line is marked
`// querycraft:`.

## What it adds

Federated authentication through the ADAL library (MS-TDS calls it ADAL, MSAL does the same job), where
the server tells the client which token authority and resource to use. This is how Microsoft's JDBC
driver (and so DBeaver), ODBC driver and go-mssqldb do `ActiveDirectoryInteractive`. Upstream tiberius
only has the security-token workflow (`AuthMethod::AADToken`), where the client has to know the tenant
before it connects. A guest account then gets a token from its home tenant, and Azure SQL rejects it
with error 18456 "The server is not currently configured to accept this token".

`AuthMethod::aad_interactive(callback)` (variant `AADInteractive(FedAuthCallback)`):

1. PRELOGIN sets FEDAUTHREQUIRED, as for `AADToken`.
2. LOGIN7 carries the FEDAUTH FeatureExt for the ADAL library: `FeatureId 0x02`, `FeatureDataLen 2`,
   `Options = (0x02 << 1) | fFedAuthEcho`, `Workflow 0x03`, then the terminator. 0x03 is the workflow
   byte mssql-jdbc sends for ActiveDirectoryInteractive; MS-TDS documents only 0x01 (password) and 0x02
   (integrated), and go-mssqldb sends 0x01 for interactive.
3. The client reads the response up to the FEDAUTHINFO token (0xEE), which upstream already decoded.
   An ERROR token before it fails the login with that error.
4. The callback gets the `TokenFedAuthInfo` (`sts_url`, `spn`) and returns an access token.
5. The client sends a Federated Authentication Token message (packet type 0x08, `PacketType::Fat`):
   `DataLen` (DWORD), the token as L_VARBYTE (DWORD byte length + UTF-16LE), and the prelogin nonce
   only if the server sent one. It is framed through the existing zeroizing `send_sensitive_login` path.
6. The login continues as before: LOGINACK, FEATUREEXTACK (an ADAL ack has no data, which upstream
   already accepts), ENVCHANGE routing and DONE in `flush_done`. After a routing redirect the caller
   connects again and the callback runs again.

The ADAL workflow refuses a connection that negotiated encryption Off or NotSupported: the token
message comes after LOGIN7, and with login-only encryption TLS is already gone by then (mssql-jdbc and
go-mssqldb drop TLS after the first LOGIN7 packet too, so they would send it in the clear).

## Files

- `src/client/auth.rs`: `FedAuthCallback`, `FedAuthToken`, `AuthMethod::AADInteractive` and
  `AuthMethod::aad_interactive`; `PartialEq` compares callbacks by pointer.
- `src/lib.rs`: re-exports `TokenFedAuthInfo`, the callback's argument.
- `src/tds/codec/login.rs`: `FED_AUTH_LIBRARYADAL`, `FED_AUTH_ADAL_WORKFLOW_INTERACTIVE`,
  `FedAuthExt::adal_workflow`, `LoginMessage::aad_adal`, the ADAL branch in `encoded_len` and
  `encode_to_boxed_slice`, and `encode_fed_auth_token`. Tests: `adal_feature_ext_bytes`,
  `fed_auth_token_message_bytes`; the test-only decoder reads the ADAL FeatureExt.
- `src/tds/stream/token.rs`: `TokenStream::flush_fed_auth_info`; the `FedAuthInfo` variant is no longer
  dead code. Tests: `flush_fed_auth_info_returns_sts_url_and_spn`,
  `flush_fed_auth_info_surfaces_the_server_error`.
- `src/client/connection.rs`: PRELOGIN's FEDAUTHREQUIRED for `AADInteractive`, and its login arm.

## References

- MS-TDS on learn.microsoft.com: LOGIN7 (the FEDAUTH FeatureExt), Federated Authentication Token,
  FEDAUTHINFO, PRELOGIN (FEDAUTHREQUIRED).
- microsoft/mssql-jdbc `SQLServerConnection.java` (`writeFedAuthFeatureRequest`, `processFedAuthInfo`,
  `FedAuthTokenCommand.sendFedAuthToken`), `IOBuffer.java` (`TDS.ADALWORKFLOW_*`,
  `PKT_FEDAUTH_TOKEN_MESSAGE`, `FEDAUTH_INFO_ID_*`), `SQLServerMSAL4JUtils.java` (authority = STS URL,
  scope = SPN + `/.default`).
- microsoft/go-mssqldb `fedauth.go`, `tds.go` (`featureExtFedAuth.toBytes`, `sendFedAuthInfo`, the login
  loop), `token.go` (`parseFedAuthInfo`).

## Upstreaming

Self-contained and additive: no existing behaviour changes. Before offering it upstream, a real
handshake against Azure SQL should be captured, and the workflow byte could become a parameter
(password, integrated, interactive).

## Gateway redirect during the ADAL handshake

Azure SQL's gateway (the default "Redirect" connection policy) answers the LOGIN7 with
`LOGINACK, ENVCHANGE(Routing), ENVCHANGE(PacketSize), DONE` and no FEDAUTHINFO: the worker it
routes to runs the handshake. `flush_fed_auth_info` returns `Error::Routing` in that case, like
`flush_done`, so the caller reconnects to the worker with the same `AADInteractive` callback.
When FEDAUTHINFO never arrives, its protocol error lists the tokens the server sent instead.
Observed against a real Azure SQL server (westus1); tested in
`flush_fed_auth_info_hands_back_the_gateway_redirect`.
