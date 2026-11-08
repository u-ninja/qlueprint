//! Port checks before provisioning, and identifying the database server behind a port.

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::types::Engine;

const PROBE_TIMEOUT: Duration = Duration::from_millis(800);
/// How far past a taken port to look for a free one.
const SEARCH: u16 = 100;

/// Free means nothing listens on 127.0.0.1:`port` and it can be bound. Both checks, because on
/// Windows a bind to 127.0.0.1 can succeed while another process listens on 0.0.0.0.
pub(crate) fn port_free(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    if TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok() {
        return false;
    }
    TcpListener::bind(addr).is_ok()
}

/// The first free port after `port`, up to 100 ports on.
pub(crate) fn next_free(port: u16, is_free: impl Fn(u16) -> bool) -> Option<u16> {
    (1..=SEARCH)
        .filter_map(|n| port.checked_add(n))
        .find(|&p| p >= 1024 && is_free(p))
}

/// Something answering on `port`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Probe {
    pub engine: Engine,
    /// MySQL and MariaDB announce their version before login; Postgres doesn't.
    pub version: Option<String>,
}

/// Reads the MySQL protocol greeting: a 4-byte packet header, protocol 10, then the
/// NUL-terminated server version (`8.4.6`, `11.4.8-MariaDB-ubu2404`).
pub(crate) fn parse_mysql_greeting(bytes: &[u8]) -> Option<Probe> {
    let payload = bytes.get(4..)?;
    if payload.first() != Some(&10) {
        return None;
    }
    let version = payload[1..].split(|&b| b == 0).next()?;
    let version = std::str::from_utf8(version).ok()?.to_owned();
    if version.is_empty() || !version.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mariadb = version.to_ascii_lowercase().contains("mariadb");
    // MariaDB 10.x prefixed its version with "5.5.5-" for old clients
    let clean = version.strip_prefix("5.5.5-").unwrap_or(&version);
    let clean = clean.split('-').next().unwrap_or(clean).to_owned();
    Some(Probe {
        engine: if mariadb {
            Engine::Mariadb
        } else {
            Engine::Mysql
        },
        version: Some(clean),
    })
}

/// Identifies the server on 127.0.0.1:`port` without logging in: MySQL-family servers greet
/// first; Postgres answers an SSLRequest with `S` or `N`.
pub(crate) async fn probe(port: u16) -> Option<Probe> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let mut buf = [0u8; 128];
    if let Ok(Ok(n)) = tokio::time::timeout(PROBE_TIMEOUT, stream.read(&mut buf)).await
        && n > 0
    {
        return parse_mysql_greeting(&buf[..n]);
    }
    // 8-byte SSLRequest: length 8, code 80877103
    let ssl_request = [0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f];
    stream.write_all(&ssl_request).await.ok()?;
    let n = tokio::time::timeout(PROBE_TIMEOUT, stream.read(&mut buf[..1]))
        .await
        .ok()?
        .ok()?;
    (n == 1 && matches!(buf[0], b'S' | b'N')).then_some(Probe {
        engine: Engine::Postgres,
        version: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn greeting(version: &str) -> Vec<u8> {
        let mut bytes = vec![0x4a, 0, 0, 0, 10];
        bytes.extend(version.as_bytes());
        bytes.extend([0, 1, 2, 3]);
        bytes
    }

    #[test]
    fn reads_mysql_and_mariadb_greetings() {
        let mysql = parse_mysql_greeting(&greeting("8.4.6")).unwrap();
        assert_eq!(
            (mysql.engine, mysql.version.as_deref()),
            (Engine::Mysql, Some("8.4.6"))
        );
        let maria = parse_mysql_greeting(&greeting("11.4.8-MariaDB-ubu2404")).unwrap();
        assert_eq!(
            (maria.engine, maria.version.as_deref()),
            (Engine::Mariadb, Some("11.4.8"))
        );
        let old = parse_mysql_greeting(&greeting("5.5.5-10.11.9-MariaDB")).unwrap();
        assert_eq!(
            (old.engine, old.version.as_deref()),
            (Engine::Mariadb, Some("10.11.9"))
        );
        assert!(parse_mysql_greeting(b"HTTP/1.1 400").is_none());
        assert!(parse_mysql_greeting(&[0, 0, 0, 0, 0xff]).is_none());
    }

    #[test]
    fn detects_a_taken_port_and_suggests_the_next_free_one() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let taken = listener.local_addr().unwrap().port();
        assert!(!port_free(taken));
        drop(listener);

        // Pure: ports 5432 and 5433 taken, 5434 free
        let free = |p: u16| p > 5433;
        assert_eq!(next_free(5432, free), Some(5434));
        assert_eq!(next_free(65535, |_| true), None);
        assert_eq!(next_free(5432, |_| false), None);
    }

    #[tokio::test]
    async fn probes_nothing_on_a_closed_port() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(probe(port).await.is_none());
    }
}
