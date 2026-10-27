#!/usr/bin/env bash
# OWASP ZAP's baseline (passive: it only looks at the answers) against a
# local front door: this bff and arcanum-frontends in one `wrangler dev`
# (the service binding connects them), no backend. Run by the CI of both
# repos: .zap/scan.sh <bff dir> <frontends dir, built (dist/)>.
#
# FRONTEND_URL is 127.0.0.2, not localhost: on localhost the bff takes its
# development paths (HTTP forwarding, cookies without Secure / __Host-), and
# the scan should see what an installation serves. The login provider is
# login.kaboutersoft.be with a client that doesn't exist - /login answers as
# it does in production (a redirect and its state cookie), nobody signs in.
#
# Triaged findings, each with its reason, in .zap/rules.tsv; anything new
# fails. Reports in <bff dir>/zap-report/.
set -u
bff=$(cd "$1" && pwd)
frontends=$(cd "$2" && pwd)
base=http://127.0.0.2:8787

# A fresh checkout only: it writes its own .dev.vars.
[ -e "$bff/.dev.vars" ] && { echo "$bff/.dev.vars exists - run this on a fresh checkout"; exit 1; }
{
  echo "FRONTEND_URL=$base"
  echo "BFF_INTERNAL_KEY=$(openssl rand -base64 32)"
  echo "DEFAULT_IDP_ISSUER_URL=https://login.kaboutersoft.be"
  echo "DEFAULT_IDP_CLIENT_ID=zap-scan"
  echo "DEFAULT_IDP_CLIENT_SECRET=not-a-secret"
} > "$bff/.dev.vars"

cd "$bff"
npx wrangler dev -c wrangler.jsonc -c "$frontends/wrangler.jsonc" --port 8787 --ip 0.0.0.0 > wrangler.log 2>&1 &
for i in $(seq 1 60); do curl -sf "$base/health" > /dev/null && break; sleep 2; done

mkdir -p zap-report && chmod a+w zap-report && cp .zap/rules.tsv zap-report/
status=0
# A screen (every one gets its headers from the same place), a guest's
# self-order page, the sign-in. The spider follows on to /, assets, icons.
for target in /device /bestel/scan /login; do
  name=$(echo "$target" | tr -c 'a-z\n' '-' | sed 's/^-//')
  echo "::group::ZAP $target"
  docker run --rm --network=host -v "$bff/zap-report:/zap/wrk:rw" ghcr.io/zaproxy/zaproxy:stable \
    zap-baseline.py -t "$base$target" -a -j -c rules.tsv -r "$name.html" -J "$name.json" || status=1
  echo "::endgroup::"
done
[ $status = 0 ] || cat wrangler.log
exit $status
