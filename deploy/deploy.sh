#!/usr/bin/env bash

set -eux
set -o pipefail

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

pushd ${SCRIPT_DIR}/../driver
CARGO_TARGET_ARM_UNKNOWN_LINUX_GNUEABIHF_RUSTFLAGS="--cfg tokio_unstable" cross build --target arm-unknown-linux-gnueabihf --release
popd

ssh led@led.local 'bash -s' < ${SCRIPT_DIR}/bootstrap.sh
scp ${SCRIPT_DIR}/../driver/target/arm-unknown-linux-gnueabihf/release/led-driver led@led.local:/opt/led

scp ${SCRIPT_DIR}/led-driver.service led@led.local:/opt/led
ssh led@led.local 'bash -s' < ${SCRIPT_DIR}/service.sh

