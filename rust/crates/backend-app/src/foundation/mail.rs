//! SMTP delivery for password recovery codes, configured only by environment.
use std::time::Duration;

use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, MultiPart},
    transport::smtp::Error as SmtpError,
};
use silverhand_backend_server::identity_access::password_recovery::{
    MailSendFailure, RecoveryMailer,
};

const SMTP_URL_ENV: &str = "SILVERHAND_SMTP_URL";
const MAIL_FROM_ENV: &str = "SILVERHAND_MAIL_FROM";
const SMTP_TIMEOUT: Duration = Duration::from_secs(10);
const RECOVERY_HTML: &str = include_str!("mail/recovery-code.html");

/// Parsed at startup; holds credentials, so it never derives `Debug` with contents.
#[derive(Clone)]
pub struct MailConfig {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
}

impl std::fmt::Debug for MailConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("MailConfig([REDACTED])")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MailConfigError {
    #[error("SILVERHAND_SMTP_URL and SILVERHAND_MAIL_FROM must be set together")]
    Incomplete,
    #[error(
        "SILVERHAND_SMTP_URL must be smtps://… (implicit TLS) or smtp://…?tls=required (STARTTLS)"
    )]
    InvalidUrl,
    #[error("SILVERHAND_MAIL_FROM is not a valid mailbox")]
    InvalidFrom,
}

impl MailConfig {
    pub fn from_env() -> Result<Option<Self>, MailConfigError> {
        let read = |name| {
            std::env::var(name)
                .ok()
                .filter(|value: &String| !value.trim().is_empty())
        };
        Self::parse(
            read(SMTP_URL_ENV).as_deref(),
            read(MAIL_FROM_ENV).as_deref(),
        )
    }

    pub fn parse(url: Option<&str>, from: Option<&str>) -> Result<Option<Self>, MailConfigError> {
        let (url, from) = match (url, from) {
            (None, None) => return Ok(None),
            (Some(url), Some(from)) => (url.trim(), from.trim()),
            _ => return Err(MailConfigError::Incomplete),
        };
        if !requires_tls(url) {
            return Err(MailConfigError::InvalidUrl);
        }
        let transport = AsyncSmtpTransport::<Tokio1Executor>::from_url(url)
            .map_err(|_| MailConfigError::InvalidUrl)?
            .timeout(Some(SMTP_TIMEOUT))
            .build();
        let from = from.parse().map_err(|_| MailConfigError::InvalidFrom)?;
        Ok(Some(Self { transport, from }))
    }
}

/// lettre reads `smtp://` without `tls=` as plaintext and `tls=opportunistic` as
/// downgradable; only implicit TLS or required STARTTLS may carry codes and credentials.
fn requires_tls(raw: &str) -> bool {
    let Ok(url) = url::Url::parse(raw) else {
        return false;
    };
    let tls: Vec<_> = url
        .query_pairs()
        .filter(|(key, _)| key == "tls")
        .map(|(_, value)| value.into_owned())
        .collect();
    match url.scheme() {
        "smtps" => tls.is_empty(),
        "smtp" => tls == ["required"],
        _ => false,
    }
}

fn send_failure(error: &SmtpError) -> MailSendFailure {
    let kind = if error.is_permanent() {
        "permanent"
    } else if error.is_transient() {
        "transient"
    } else if error.is_timeout() {
        "timeout"
    } else if error.is_tls() {
        "tls"
    } else if error.is_response() {
        "response"
    } else if error.is_client() {
        "client"
    } else {
        "connection"
    };
    MailSendFailure {
        kind,
        smtp_status: error
            .status()
            .and_then(|code| code.to_string().parse().ok()),
    }
}

/// `code` is six ASCII digits, so it needs no HTML escaping.
fn recovery_body(code: &str) -> MultiPart {
    MultiPart::alternative_plain_html(
        format!(
            "Your Silverhand password reset code is {code}.\n\n\
             It expires in 15 minutes and can be used once. \
             If you did not request it, ignore this email; your password has not changed.\n"
        ),
        RECOVERY_HTML.replace("{code}", code),
    )
}

const MESSAGE_FAILURE: MailSendFailure = MailSendFailure {
    kind: "message",
    smtp_status: None,
};

impl RecoveryMailer for MailConfig {
    async fn send(&self, to: &str, code: &str) -> Result<(), MailSendFailure> {
        let message = Message::builder()
            .from(self.from.clone())
            .to(to.parse().map_err(|_| MESSAGE_FAILURE)?)
            .subject("Silverhand password reset code")
            .multipart(recovery_body(code))
            .map_err(|_| MESSAGE_FAILURE)?;
        self.transport
            .send(message)
            .await
            .map_err(|error| send_failure(&error))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mail_configuration_is_all_or_nothing() {
        assert!(MailConfig::parse(None, None).unwrap().is_none());
        assert!(matches!(
            MailConfig::parse(Some("smtps://u:p@smtp.example.com:465"), None),
            Err(MailConfigError::Incomplete)
        ));
        assert!(matches!(
            MailConfig::parse(None, Some("a@example.com")),
            Err(MailConfigError::Incomplete)
        ));
        assert!(matches!(
            MailConfig::parse(Some("https://smtp.example.com"), Some("a@example.com")),
            Err(MailConfigError::InvalidUrl)
        ));
        assert!(matches!(
            MailConfig::parse(
                Some("smtps://u:p@smtp.example.com:465"),
                Some("not a mailbox")
            ),
            Err(MailConfigError::InvalidFrom)
        ));
        let config = MailConfig::parse(
            Some("smtps://user:secret@smtp.example.com:465"),
            Some("Silverhand <no-reply@example.com>"),
        )
        .unwrap()
        .unwrap();
        assert!(!format!("{config:?}").contains("secret"));
    }

    #[test]
    fn the_recovery_mail_carries_the_code_in_both_parts() {
        let body = String::from_utf8(recovery_body("482913").formatted()).unwrap();
        assert!(body.contains("text/plain") && body.contains("text/html"));
        assert_eq!(
            body.matches("482913").count(),
            3,
            "plain, preheader, code block"
        );
        assert!(!body.contains("{code}"));
    }

    #[test]
    fn only_tls_that_cannot_be_downgraded_is_accepted() {
        let from = Some("no-reply@example.com");
        for url in [
            "smtps://u:p@smtp.example.com:465",
            "smtp://u:p@smtp.example.com:587?tls=required",
        ] {
            assert!(
                MailConfig::parse(Some(url), from).unwrap().is_some(),
                "{url}"
            );
        }
        for url in [
            "smtp://u:p@smtp.example.com:587",
            "smtp://u:p@smtp.example.com:25?tls=opportunistic",
            "smtp://u:p@smtp.example.com:587?tls=none",
            "smtp://u:p@smtp.example.com:587?tls=required&tls=opportunistic",
            "smtps://u:p@smtp.example.com:465?tls=opportunistic",
        ] {
            assert!(
                matches!(
                    MailConfig::parse(Some(url), from),
                    Err(MailConfigError::InvalidUrl)
                ),
                "{url}"
            );
        }
    }

    #[tokio::test]
    async fn a_rejecting_smtp_reply_reaches_logs_only_as_its_status() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let (read, mut write) = socket.into_split();
            let mut lines = BufReader::new(read).lines();
            write.write_all(b"220 test ESMTP\r\n").await.unwrap();
            while let Some(line) = lines.next_line().await.unwrap() {
                let reply: &[u8] = if line.starts_with("EHLO") {
                    b"250 test\r\n"
                } else if line.starts_with("MAIL") {
                    b"250 ok\r\n"
                } else if line.starts_with("RCPT") {
                    b"550 <alice@example.com> recipient rejected\r\n"
                } else {
                    b"221 bye\r\n"
                };
                write.write_all(reply).await.unwrap();
            }
        });
        // Plaintext only against this loopback fixture; product config cannot build this.
        let config = MailConfig {
            transport: AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous("127.0.0.1")
                .port(port)
                .timeout(Some(SMTP_TIMEOUT))
                .build(),
            from: "no-reply@example.com".parse().unwrap(),
        };
        let failure = config
            .send("alice@example.com", "123456")
            .await
            .unwrap_err();
        assert_eq!(
            failure,
            MailSendFailure {
                kind: "permanent",
                smtp_status: Some(550)
            }
        );
        let logged = format!("{failure:?}");
        assert!(
            !logged.contains("alice") && !logged.contains("123456"),
            "{logged}"
        );
    }
}
