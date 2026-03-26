#!/bin/bash
# create the snapshot repo in ES
: ${ES_SNAPSHOT_REPO:?}
: ${AWS_BUCKET:?}

echo '[INFO] waiting for Elasticsearch to be ready...'
until curl -sf http://localhost:9200/_cluster/health > /dev/null 2>&1; do
  echo '[INFO] ES not ready yet, retrying in 5s...'
  sleep 5
done
echo '[INFO] Elasticsearch is ready'

curl \
  -X PUT \
  -H 'content-type: application/json' \
  -d '{"type":"s3","settings":{"bucket":"'$AWS_BUCKET'"}}' \
  http://localhost:9200/_snapshot/${ES_SNAPSHOT_REPO}

echo '[INFO] S3 snapshot repo registered'