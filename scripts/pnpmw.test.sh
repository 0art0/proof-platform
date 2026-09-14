#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  echo "pnpmw test failed: $*" >&2
  exit 1
}

assert_file_lines() {
  local expected="$1"
  local file="$2"
  local actual

  actual="$(wc -l <"$file" | tr -d '[:space:]')"
  [[ "$actual" == "$expected" ]] || fail "expected $expected lines in $file, found $actual"
}

pin_count="$(grep -Ec '^enableGlobalVirtualStore:[[:space:]]+false[[:space:]]*$' "$repo_root/pnpm-workspace.yaml")"
[[ "$pin_count" == "1" ]] || fail "pnpm-workspace.yaml must pin enableGlobalVirtualStore to false exactly once"

test_tmp="$(mktemp -d "${TMPDIR:-/tmp}/pnpmw-test.XXXXXX")"
cleanup() {
  if [[ -n "${test_tmp:-}" && -d "$test_tmp" && "$(basename "$test_tmp")" == pnpmw-test.* ]]; then
    rm -rf -- "$test_tmp"
  fi
}
trap cleanup EXIT

make_fixture() {
  local fixture_root="$1"

  mkdir -p \
    "$fixture_root/scripts" \
    "$fixture_root/.tools/node-v24.20.0-linux-x64/bin" \
    "$fixture_root/.tools/pnpm-home"
  cp "$repo_root/scripts/pnpmw" "$fixture_root/scripts/pnpmw"
  cp "$repo_root/pnpm-workspace.yaml" "$fixture_root/pnpm-workspace.yaml"

  printf '%s\n' '#!/usr/bin/env bash' 'exit 0' >"$fixture_root/.tools/node-v24.20.0-linux-x64/bin/node"

  cat >"$fixture_root/.tools/pnpm-home/corepack" <<'COREPACK'
#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == "pnpm" ]] || exit 90

{
  printf '%s' "$PWD"
  printf '\t%s' "$@"
  printf '\n'
} >>"${PNPMW_TEST_LOG:?}"

shift
command_root="$PWD"
while (($#)); do
  case "$1" in
    --dir)
      command_root="$2"
      shift 2
      ;;
    -F | --filter | --filter-prod)
      shift 2
      ;;
    --dir=*)
      command_root="${1#*=}"
      shift
      ;;
    --filter=* | --filter-prod=*)
      shift
      ;;
    *)
      break
      ;;
  esac
done

command_name="${1:-}"
if (($#)); then
  shift
fi

workspace_root="$command_root"
while [[ ! -f "$workspace_root/pnpm-workspace.yaml" && "$workspace_root" != "/" ]]; do
  workspace_root="$(dirname "$workspace_root")"
done

case "$command_name" in
  i | install)
    [[ "$*" == "--frozen-lockfile" ]] || exit 91
    [[ "${PNPMW_TEST_INSTALL_FAILURE:-0}" == "0" ]] || exit "$PNPMW_TEST_INSTALL_FAILURE"
    mkdir -p "$command_root/node_modules"
    if [[ ! -e "$command_root/node_modules/.pnpmw-test-installed" ]]; then
      printf '%s\n' installed >"$command_root/node_modules/.pnpmw-test-installed"
    fi
    ;;
  c | config)
    [[ "${1:-}" == "get" && "${2:-}" == "enableGlobalVirtualStore" ]] || exit 92
    grep -E '^enableGlobalVirtualStore:[[:space:]]+false[[:space:]]*$' "$workspace_root/pnpm-workspace.yaml" >/dev/null || exit 93
    printf '%s\n' false
    ;;
  *)
    [[ -e "$workspace_root/node_modules/.pnpmw-test-installed" ]] || exit 94
    [[ "${PNPMW_TEST_COMMAND_FAILURE:-0}" == "0" ]] || exit "$PNPMW_TEST_COMMAND_FAILURE"
    ;;
esac
COREPACK

  chmod +x \
    "$fixture_root/scripts/pnpmw" \
    "$fixture_root/.tools/node-v24.20.0-linux-x64/bin/node" \
    "$fixture_root/.tools/pnpm-home/corepack"
}

fixture_one="$test_tmp/worktree-one"
fixture_two="$test_tmp/worktree-two"
make_fixture "$fixture_one"
make_fixture "$fixture_two"

log_one="$test_tmp/worktree-one.log"
log_two="$test_tmp/worktree-two.log"
: >"$log_one"
: >"$log_two"

(
  cd "$fixture_one"
  PNPMW_TEST_LOG="$log_one" ./scripts/pnpmw config get enableGlobalVirtualStore
) >"$test_tmp/config-one.out" &
pid_one=$!
(
  cd "$fixture_two"
  PNPMW_TEST_LOG="$log_two" ./scripts/pnpmw config get enableGlobalVirtualStore
) >"$test_tmp/config-two.out" &
pid_two=$!
wait "$pid_one"
wait "$pid_two"

[[ "$(<"$test_tmp/config-one.out")" == "false" ]] || fail "first worktree did not read the pinned setting"
[[ "$(<"$test_tmp/config-two.out")" == "false" ]] || fail "second worktree did not read the pinned setting"
assert_file_lines 1 "$log_one"
assert_file_lines 1 "$log_two"

: >"$log_one"
(
  cd "$fixture_one"
  PNPMW_TEST_LOG="$log_one" ./scripts/pnpmw --filter example run lint --flag
)

marker="$fixture_one/node_modules/.pnpmw-test-installed"
[[ -e "$marker" ]] || fail "dependency command did not bootstrap an install"
marker_checksum="$(cksum "$marker")"
assert_file_lines 2 "$log_one"
[[ "$(sed -n '1p' "$log_one")" == "$fixture_one"$'\tpnpm\t--dir\t'"$fixture_one"$'\tinstall\t--frozen-lockfile' ]] || fail "bootstrap install was not the first command"
[[ "$(sed -n '2p' "$log_one")" == "$fixture_one"$'\tpnpm\t--filter\texample\trun\tlint\t--flag' ]] || fail "requested command arguments were not preserved"

(
  cd "$fixture_one"
  PNPMW_TEST_LOG="$log_one" ./scripts/pnpmw --filter example run lint --flag
)

[[ "$(cksum "$marker")" == "$marker_checksum" ]] || fail "second bootstrap install changed the installed marker"
assert_file_lines 4 "$log_one"
[[ "$(sed -n '3p' "$log_one")" == "$(sed -n '1p' "$log_one")" ]] || fail "second run did not repeat the same idempotent install"
[[ "$(sed -n '4p' "$log_one")" == "$(sed -n '2p' "$log_one")" ]] || fail "second run did not preserve the requested command"

package_dir="$fixture_one/packages/example"
mkdir -p "$package_dir"
: >"$log_one"
(
  cd "$package_dir"
  PNPMW_TEST_LOG="$log_one" ../../scripts/pnpmw run lint
)
assert_file_lines 2 "$log_one"
[[ "$(sed -n '1p' "$log_one")" == "$package_dir"$'\tpnpm\t--dir\t'"$fixture_one"$'\tinstall\t--frozen-lockfile' ]] || fail "package command did not install at the workspace root"
[[ "$(sed -n '2p' "$log_one")" == "$package_dir"$'\tpnpm\trun\tlint' ]] || fail "package command did not preserve its working directory"

bypass_fixture="$test_tmp/worktree-bypass"
bypass_log="$test_tmp/worktree-bypass.log"
make_fixture "$bypass_fixture"
: >"$bypass_log"
(
  cd "$bypass_fixture"
  PNPMW_TEST_LOG="$bypass_log" ./scripts/pnpmw install --frozen-lockfile
)
assert_file_lines 1 "$bypass_log"

: >"$bypass_log"
(
  cd "$bypass_fixture"
  PNPMW_TEST_LOG="$bypass_log" ./scripts/pnpmw --filter example config get enableGlobalVirtualStore
) >"$test_tmp/config-bypass.out"
[[ "$(<"$test_tmp/config-bypass.out")" == "false" ]] || fail "config command did not return the pinned setting"
assert_file_lines 1 "$bypass_log"

failure_fixture="$test_tmp/worktree-failure"
failure_log="$test_tmp/worktree-failure.log"
make_fixture "$failure_fixture"
: >"$failure_log"
set +e
(
  cd "$failure_fixture"
  PNPMW_TEST_LOG="$failure_log" PNPMW_TEST_INSTALL_FAILURE=23 ./scripts/pnpmw run lint
)
install_status=$?
set -e
[[ "$install_status" == "23" ]] || fail "bootstrap install failure was not returned"
assert_file_lines 1 "$failure_log"

: >"$failure_log"
set +e
(
  cd "$failure_fixture"
  PNPMW_TEST_LOG="$failure_log" PNPMW_TEST_COMMAND_FAILURE=29 ./scripts/pnpmw run lint
)
command_status=$?
set -e
[[ "$command_status" == "29" ]] || fail "requested command failure was not returned"
assert_file_lines 2 "$failure_log"

printf '%s\n' "pnpmw regression tests passed"
