//! `led-driver` management utility.
//!
//! `led-driverup` is a simple management utility for the `led-driver` LED matrix driver. The management utility can be
//! used on an LED matrix setup to manage the `led-driver` including initializing the driver, updating the driver, and
//! pulling configuration. The management utility can also be used to both the driver software and configuration.

#![warn(missing_docs)]
#![warn(clippy::all)]
#![warn(clippy::pedantic)]
#![warn(clippy::cargo)]

use aws_sdk_s3::primitives::ByteStream;
use clap::{Parser, Subcommand};
use env_logger;
use led_driver_common::config::{load_config, save_config, Config};
use led_driver_common::root::ensure_running_as_root;
use log;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use std::time::Duration;
use toml;

/// Management utility for the LED driver.
#[derive(Parser)]
#[clap(author, version, about, long_about = None)]
struct Args {
    /// The subcommand to execute.
    #[clap(subcommand)]
    command: Commands,

    /// Use debug version.
    ///
    /// If set to true, the management utility will use the debug version of the LED driver for all operations.
    #[clap(long)]
    use_debug: bool,
}

/// Available subcommands for the LED driver management utility.
#[derive(Subcommand)]
enum Commands {
    /// Release a new version of the LED driver.
    Release {
        /// The path to the driver folder.
        #[clap(long, value_parser, default_value = "driver")]
        driver_folder: PathBuf,
        /// The path to the target folder which will contain the cross-compiled binary.
        #[clap(long, value_parser, default_value = "target")]
        target_folder: PathBuf,
    },
    /// Initialize the LED driver on a new system.
    Init {
        /// The unique identifier for this LED matrix.
        #[clap(long, value_parser)]
        id: String,
        /// The configuration file path for the LED driver.
        #[clap(long, value_parser, default_value = "/usr/local/etc/led/config.toml")]
        config_path: PathBuf,
        /// Recreate the configuration file if it already exists.
        #[clap(long, default_value = "false")]
        recreate_config: bool,
    },
    /// Upgrade the LED driver to the latest version.
    Upgrade {
        /// Continuously watch for updates and apply them.
        #[clap(long)]
        watch: bool,
        /// The frequency (in seconds) to check for updates when watching.
        #[clap(long, default_value = "60")]
        check_frequency: u64,
        /// The configuration file path for the LED driver.
        #[clap(long, value_parser, default_value = "/usr/local/etc/led/config.toml")]
        config_path: PathBuf,
        /// Whether to start the systemd service after upgrading.
        #[clap(long, default_value = "true")]
        start_service: bool,
    },
}

async fn create_s3_client() -> anyhow::Result<aws_sdk_s3::Client> {
    log::debug!("Loading `supabase` AWS credentials...");
    let aws_config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .profile_name("supabase")
        .load()
        .await;
    if !aws_config.endpoint_url().is_some() {
        return Err(anyhow::anyhow!(
            "Supabase credentials not found in AWS credentials file, see \
            https://supabase.com/docs/guides/storage/s3/authentication?queryGroups=language&language=credentials"
        ));
    }

    Ok(aws_sdk_s3::Client::from_conf(
        aws_sdk_s3::Config::from(&aws_config)
            .to_builder()
            .behavior_version_latest()
            .force_path_style(true)
            .region(aws_config::Region::from_static("us-west-1"))
            .endpoint_url("https://ohowojanrhlzhgwuwkrd.supabase.co/storage/v1/s3/")
            .build(),
    ))
}

fn get_build_version(driver_folder: &Path, use_debug: bool) -> anyhow::Result<String> {
    log::debug!("Getting build version...");
    if use_debug {
        log::debug!("Got debug version");
        return Ok(String::from("debug"));
    }

    let cargo_toml_path = driver_folder.join("Cargo.toml");
    log::debug!("Reading Cargo.toml from path: {:?}...", cargo_toml_path);
    let cargo_toml = fs::read_to_string(&cargo_toml_path)?;
    log::debug!("Parsing Cargo.toml contents and extracting version...");
    let parsed_toml: toml::Value = toml::from_str(&cargo_toml)?;
    let version = parsed_toml["package"]["version"]
        .as_str()
        .map(ToString::to_string)
        .ok_or_else(|| {
            log::error!("Failed to get version from Cargo.toml");
            anyhow::anyhow!("Failed to get version from Cargo.toml")
        })?;
    log::debug!("Got build version: {}", version);
    Ok(version)
}

fn get_current_running_version() -> anyhow::Result<String> {
    log::debug!("Getting current running version...");
    let output = Command::new("led-driver").arg("--version").output()?;

    if output.status.success() {
        let version = String::from_utf8(output.stdout)?
            .trim()
            .split_whitespace()
            .last()
            .ok_or_else(|| anyhow::anyhow!("Failed to extract version from command output"))?
            .to_string();
        log::debug!("Current running version: {}", version);
        Ok(version)
    } else {
        let error = String::from_utf8(output.stderr)?;
        log::error!("Failed to get current version: {}", error);
        Err(anyhow::anyhow!("Failed to get current version: {}", error))
    }
}

async fn get_latest_version(use_debug: bool) -> anyhow::Result<String> {
    log::debug!("Getting latest version...");
    if use_debug {
        log::debug!("Got debug version");
        return Ok(String::from("debug"));
    }

    let latest_version = reqwest::get(
        "https://ohowojanrhlzhgwuwkrd.supabase.co/storage/v1/object/public/releases/latest-version",
    )
    .await?
    .text()
    .await?
    .trim()
    .to_string();

    log::debug!("Got latest version: {}", latest_version);
    Ok(latest_version)
}

async fn download_release(version: &str) -> anyhow::Result<Vec<u8>> {
    log::debug!("Downloading release version {}...", version);
    let binary_name = format!("led-driver-{}", version);
    let url = format!(
        "https://ohowojanrhlzhgwuwkrd.supabase.co/storage/v1/object/public/releases/versions/{}",
        binary_name
    );

    let response = reqwest::get(&url).await?;
    let bytes = response.bytes().await?.to_vec();

    log::debug!("Downloaded {} bytes for version {}", bytes.len(), version);
    Ok(bytes)
}

async fn download_and_install_release(version: &str, install_path: &Path) -> anyhow::Result<()> {
    let binary_data = download_release(version).await?;
    if let Some(parent) = install_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&install_path, binary_data)?;
    fs::set_permissions(&install_path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

async fn release(
    driver_folder: &Path,
    target_folder: &Path,
    use_debug: bool,
) -> anyhow::Result<()> {
    let version = get_build_version(driver_folder, use_debug)?;
    let binary_name = format!("led-driver-{}", version);

    log::info!("Releasing {}...", binary_name);

    log::debug!("Compiling latest driver...");
    let status = Command::new("cross")
        .env(
            "CARGO_TARGET_ARM_UNKNOWN_LINUX_GNUEABIHF_RUSTFLAGS",
            "--cfg tokio_unstable",
        )
        .args(&[
            "build",
            "--package",
            "led-driver",
            "--target",
            "arm-unknown-linux-gnueabihf",
            "--release",
            "--target-dir",
            target_folder.to_str().unwrap(),
        ])
        .status()
        .map_err(|e| anyhow::anyhow!("Failed to compile driver: {}", e))?;
    if !status.success() {
        return Err(anyhow::anyhow!(
            "Failed to compile driver: exit code {}",
            status.code().unwrap_or(-1)
        ));
    }

    let s3_client = create_s3_client().await?;

    log::debug!("Uploading binary to Supabase storage...");
    let binary_path = target_folder.join("arm-unknown-linux-gnueabihf/release/led-driver");
    s3_client
        .put_object()
        .bucket("releases")
        .key(format!("versions/{}", binary_name))
        .body(ByteStream::from_path(&binary_path).await?)
        .send()
        .await?;
    log::info!(
        "Uploaded binary to Supabase storage: led-driver-{}",
        version
    );

    log::debug!("Updating latest-version file...");
    if !use_debug {
        s3_client
            .put_object()
            .bucket("releases")
            .key("latest-version")
            .body(ByteStream::from(version.as_bytes().to_vec()))
            .send()
            .await?;
        log::debug!("Updated latest-version file to {}", version);
    } else {
        log::debug!("Skipping latest-version update for debug version");
    }

    Ok(())
}

async fn init(
    id: &str,
    config_path: &Path,
    should_recreate_config: bool,
    use_debug: bool,
) -> anyhow::Result<()> {
    ensure_running_as_root()?;

    log::info!("Initializing driver configuration and service...");

    log::debug!("Checking ALSA blacklist configuration...");
    let alsa_blacklist_path = Path::new("/etc/modprobe.d/alsa-blacklist.conf");
    if !alsa_blacklist_path.exists() {
        log::info!("Creating ALSA blacklist configuration...");
        fs::write(alsa_blacklist_path, "blacklist snd_bcm2835")?;
        log::warn!("Reboot the Raspberry Pi for the changes to take effect");
        return Err(anyhow::anyhow!("Reboot required for ALSA changes"));
    }
    log::debug!("Verifying ALSA blacklist...");
    let lsmod_output = Command::new("lsmod")
        .output()
        .map_err(|e| anyhow::anyhow!("Failed to run lsmod: {}", e))?;
    if String::from_utf8_lossy(&lsmod_output.stdout).contains("snd_bcm2835") {
        log::warn!("snd_bcm2835 module is still loaded. Blacklist may not be effective.");
        log::warn!("Please reboot the Raspberry Pi and run the initialization again.");
        return Err(anyhow::anyhow!("Blacklist not effective, reboot required"));
    } else {
        log::debug!("ALSA blacklist verification successful: snd_bcm2835 not loaded");
    }

    log::debug!("Checking configuration...");
    if !config_path.exists() || should_recreate_config {
        log::debug!("Creating new configuration...");
        let config = Config {
            id: id.to_string(),
            install_path: PathBuf::from("/usr/local/bin/led-driver"),
            log_dir: PathBuf::from("/var/log/led/"),
        };
        save_config(&config, &config_path)?;
        log::debug!("Configuration created successfully");
    } else {
        log::debug!("Configuration already exists, skipping creation");
    }
    let config = load_config(&config_path)?;

    log::debug!("Downloading latest driver version...");
    let latest_version = get_latest_version(use_debug).await?;
    download_and_install_release(&latest_version, &config.install_path).await?;

    log::debug!("Creating systemd service...");
    let service_content = format!(
        r#"[Unit]
Description=LED Driver Service
After=network.target

[Service]
Type=simple
ExecStart={} --config {}
Restart=always
User=root

[Install]
WantedBy=multi-user.target
"#,
        config.install_path.display(),
        config_path.display()
    );
    fs::write("/etc/systemd/system/led-driver.service", service_content)?;

    log::debug!("Enabling and starting led-driver service...");
    Command::new("systemctl")
        .args(&["enable", "led-driver.service"])
        .status()?;
    Command::new("systemctl")
        .args(&["start", "led-driver.service"])
        .status()?;

    log::info!("Successfully initialized driver configuration and service");
    Ok(())
}

async fn upgrade(config_path: &Path, use_debug: bool, restart_service: bool) -> anyhow::Result<()> {
    ensure_running_as_root()?;

    log::info!("Checking for driver upgrades...");

    let config = load_config(config_path)?;
    let latest_version = get_latest_version(use_debug).await?;
    let current_version = get_current_running_version()?;

    if latest_version != current_version {
        log::info!("New version available: {}, upgrading...", latest_version);

        log::debug!("Stopping led-driver service...");
        Command::new("systemctl")
            .args(&["stop", "led-driver.service"])
            .status()?;

        download_and_install_release(&latest_version, &config.install_path).await?;

        if restart_service {
            log::debug!("Starting led-driver service...");
            Command::new("systemctl")
                .args(&["start", "led-driver.service"])
                .status()?;
        } else {
            log::info!("Skipping service restart as requested");
        }

        log::info!("Successfully upgraded to version {}", latest_version);
    } else {
        log::info!("Already running the latest version: {}", current_version);
    }
    Ok(())
}

async fn run(args: Args) -> anyhow::Result<()> {
    match &args.command {
        Commands::Release {
            driver_folder,
            target_folder,
        } => release(driver_folder, target_folder, args.use_debug).await,
        Commands::Init {
            id,
            config_path,
            recreate_config,
        } => init(id, config_path, *recreate_config, args.use_debug).await,
        Commands::Upgrade {
            watch,
            check_frequency,
            config_path,
            start_service,
        } => {
            if *watch {
                loop {
                    if let Err(e) = upgrade(config_path, args.use_debug, *start_service).await {
                        log::error!("Error during upgrade: {}", e);
                    }
                    thread::sleep(Duration::from_secs(*check_frequency));
                }
            } else {
                upgrade(config_path, args.use_debug, *start_service).await
            }
        }
    }
}

#[tokio::main]
async fn main() {
    human_panic::setup_panic!();
    env_logger::init();

    let args = Args::parse();

    if let Err(e) = run(args).await {
        log::error!("Error: {}", e);
        std::process::exit(1);
    }
}
