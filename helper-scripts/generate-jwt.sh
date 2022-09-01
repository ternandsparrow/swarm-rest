#!/bin/bash
set -euxo pipefail
cd "$(dirname "$0")"

theRole=staff
# confirming role name (easier than parsing the SQL to extract it)
grep "CREATE ROLE $theRole" ../script.sql &> /dev/null
theSecret=$(grep PGRST_JWT_SECRET ../start-or-restart.sh | sed 's/.*=//')

pyScriptPath=tmp-jwt-gen.py
cat <<HEREDOC > $pyScriptPath
import jwt
encoded_jwt = jwt.encode({"role": "$theRole"}, "$theSecret", algorithm="HS256")
print(encoded_jwt)
print()
print('Test the token with')
print('  curl -v \\\\')
print('    -H "Content-Type: application/json" \\\\')
print('    -H "Authorization: Bearer %s" \\\\' % encoded_jwt)
print('    "http://swarmapi.ausplots.aekos.org.au/site?limit=1"')
HEREDOC

echo "pip install pyjwt; python /app/$pyScriptPath" \
  | docker run --rm -i --entrypoint sh -v $PWD:/app:ro python:3-alpine
