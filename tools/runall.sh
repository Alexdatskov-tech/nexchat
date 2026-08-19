#!/bin/bash
cd /tmp/nxtest
pass=0; fail=0
single="test-picker test-css test-auth test-srvname test-tiff test-fonts test-bgperf test-halo test-sql test-admin"
multi="test-server test-dms test-rx test-editdel test-presence test-guard"
for t in $single; do
  if node $t.js >/tmp/nxtest/out.$t 2>&1; then echo "PASS  $t"; pass=$((pass+1)); else echo "FAIL  $t"; fail=$((fail+1)); tail -5 /tmp/nxtest/out.$t; fi
done
for t in $multi; do
  for m in silent live ""; do
    if SOCKET=$m node $t.js >/tmp/nxtest/out.$t.$m 2>&1; then echo "PASS  $t SOCKET='$m'"; pass=$((pass+1)); else echo "FAIL  $t SOCKET='$m'"; fail=$((fail+1)); tail -5 /tmp/nxtest/out.$t.$m; fi
  done
done
echo "---- $pass passed, $fail failed"
