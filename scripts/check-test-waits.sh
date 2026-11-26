#!/usr/bin/env bash
# check-test-waits.sh: fail on a new sleep or a new long wait in a test file.
#
# backend/docs/TESTING.md, Rules: "No sleeps" (a test does not wait for real time to pass) and
# "No wait over 5 s". The places that were in the tests when this guard came are listed, per file
# and kind with their count, in scripts/check-test-waits.allowlist; the guard fails only when a file
# has more than its entry allows (a file without an entry allows none). Reduce the list, do not
# grow it: when a file needs fewer, lower or remove its entry (the guard prints a note).
#
# Test files: backend/src/**/*.spec.ts, backend/src/testing/**, backend/test/**,
# frontend/src/**/*.{test,spec}.{ts,tsx}, frontend/src/**/__tests__/**, frontend/src/test/**,
# frontend/e2e/**.
#
# sleep: one per line (comment lines skipped) that has
#   - a setTimeout wrapped in a promise: `new Promise(... setTimeout(...` on one line, or
#     `setTimeout(resolve, ...)` (also `res`, `r`); a delay of 0 passes no time and is not counted;
#   - a call of a sleep( or delay( helper (its definition too); a method such as the Temporal
#     test environment's env.sleep(), which skips time, is not counted;
#   - Playwright's waitForTimeout(.
# wait: a `timeout: N` above 5000 (ms) in the arguments of waitFor, waitUntil,
#   waitForElementToBeRemoved or a findBy*/findAllBy* query, or in an options constant
#   (`const LOADED = { timeout: 10_000 }`). A test's own timeout (`it(name, { timeout }, fn)`) is
#   no wait and is not counted.
#
# Usage: bash scripts/check-test-waits.sh          check
#        bash scripts/check-test-waits.sh --list   print today's counts in the allow-list format
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ALLOWLIST="$SCRIPT_DIR/check-test-waits.allowlist"
MODE="${1:-check}"

cd "$REPO_ROOT"
find backend/src backend/test frontend/src frontend/e2e \
  -type d -name node_modules -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print |
  sort |
  perl -e '
use strict;
use warnings;

my ($allowlist, $mode) = @ARGV;
my $LIMIT_MS = 5000;
my $test_file = qr{^(?:backend/src/.+\.spec\.ts|backend/src/testing/.+|backend/test/.+
  |frontend/src/.+\.(?:test|spec)\.tsx?|frontend/src/(?:.+/)?__tests__/.+|frontend/src/test/.+
  |frontend/e2e/.+)$}x;

sub sleeps {
  my ($src) = @_;
  my $n = 0;
  for my $line (split /\n/, $src) {
    next if $line =~ m{^\s*(?://|/?\*)};
    my $wrapped = $line =~ /\bnew Promise\b.*\bsetTimeout\s*\(/
      || $line =~ /\bsetTimeout\s*\(\s*(?:resolve|res|r)\s*[,)]/;
    # A delay of 0 (or none) passes no time: it only lets queued work run
    $wrapped = 0 if $wrapped && $line =~ /\bsetTimeout\s*\(\s*[\w\$]+\s*(?:,\s*0\s*)?\)/;
    my $helper = $line =~ /(?<![\w.\$])(?:sleep|delay)\s*\(/;
    my $playwright = $line =~ /\bwaitForTimeout\s*\(/;
    $n++ if $wrapped || $helper || $playwright;
  }
  return $n;
}

sub over_limit {
  my ($text) = @_;
  my $n = 0;
  while ($text =~ /\btimeout\s*:\s*([\d_]+)/g) {
    (my $ms = $1) =~ tr/_//d;
    $n++ if $ms > $LIMIT_MS;
  }
  return $n;
}

sub waits {
  my ($src) = @_;
  my $n = 0;
  while ($src =~ /\b(?:waitFor|waitUntil|waitForElementToBeRemoved|find(?:All)?By\w+)\s*(\((?:[^()]++|(?-1))*\))/g) {
    $n += over_limit($1);
  }
  while ($src =~ /\b(?:const|let|var)\s+\w+\s*(?::[^=;]+)?=\s*(\{\s*timeout\s*:\s*[\d_]+\s*\})/g) {
    $n += over_limit($1);
  }
  return $n;
}

my %allowed;
if ($mode ne "--list") {
  open my $fh, "<", $allowlist or die "cannot read $allowlist: $!\n";
  while (my $line = <$fh>) {
    next if $line =~ /^\s*(?:#|$)/;
    my ($kind, $count, $path) = $line =~ /^(sleep|wait)\s+(\d+)\s+(\S+)\s*$/
      or die "$allowlist line $.: expected \"sleep|wait <count> <path>\"\n";
    $allowed{"$kind $path"} = $count;
  }
}

my (@over, @under, %found);
while (my $path = <STDIN>) {
  chomp $path;
  next unless $path =~ $test_file;
  open my $fh, "<", $path or die "cannot read $path: $!\n";
  my $src = do { local $/; <$fh> };
  my %count = (sleep => sleeps($src), wait => waits($src));
  for my $kind (qw(sleep wait)) {
    my $key = "$kind $path";
    my $have = $count{$kind};
    if ($mode eq "--list") {
      print "$kind $have $path\n" if $have;
      next;
    }
    $found{$key} = 1;
    my $may = $allowed{$key} // 0;
    push @over, "$path: $have ${kind}s, the allow-list allows $may" if $have > $may;
    push @under, "$kind $may $path: now $have" if $have < $may;
  }
}
exit 0 if $mode eq "--list";
for my $key (sort keys %allowed) {
  my ($kind, $path) = split / /, $key, 2;
  push @under, "$kind $allowed{$key} $path: the file is gone or no longer a test file"
    unless $found{$key};
}

if (@under) {
  print "Note: lower or remove these entries in scripts/check-test-waits.allowlist:\n";
  print "  $_\n" for @under;
}
if (@over) {
  print STDERR "$_\n" for @over;
  print STDERR "\nA test does not sleep and does not wait longer than 5 s (backend/docs/TESTING.md, Rules).\n";
  print STDERR "Flush the pending work or poll the state the test cares about instead of a sleep, and keep\n";
  print STDERR "waitFor and findBy timeouts at 5000 ms or less (find out what makes the wait long).\n";
  exit 1;
}
print "OK: no new sleep or wait over 5 s in a test file\n";
' "$ALLOWLIST" "$MODE"
