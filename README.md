> RESTful HTTP API to serve up Ausplots data from a postgres database using
> postgREST

This directory contains the files required to run the HTTP REST API server that
the [ausplotsR client](https://github.com/ternaustralia/ausplotsR) talks to.

The DB init script (`script.sql`) does a number of things:
  1. create a schema just for the API, named `api`
  1. create a role that can SELECT from (only) the `api` schema
  1. create a number of views in the `api` schema that pull from tables in the
     `public` schema

postgREST will then serve everything from the `api` schema and because they're
just views, they'll be read-only.

We collect usage metrics on the service by intercepting all traffic to the API
and then store these metrics in ElasticSearch. Kibana is included for
visualising the usage. The ES data is also periodcally snapshotted onto S3 for
safe keeping.

As this is just a mirror of production, we have a container to periodically
synchronise the data in SWARM production into our DB.

We also have a read-only user auto-created so the DB can be used as a safe way
to share a fresh-ish mirror of production.

## Running the stack

Make sure you meet the requirements:

  1. docker >= 18.06
  1. docker-compose >= 1.22.0
  1. credentials for performing `SELECT` queries on the production Ausplots
     SWARM postgres DB, or another DB if you choose. See section below for
     creating this user.
  1. AWS credentials for IAM user to store ElasticSearch snapshots (use
     `./create-aws-s3-user-and-bucket.sh` script to create)

To start the stack:

  1. clone this repo and `cd` into the workspace
  1. [allow more virtual
     memory](https://www.elastic.co/guide/en/elasticsearch/reference/current/vm-max-map-count.html#vm-max-map-count)
     on the host (ES needs this)
      ```bash
      echo vm.max_map_count=262144 | sudo tee -a /etc/sysctl.conf # only run this once for a host
      sudo sysctl -p # read the new config
      ```
  1. copy the runner script
      ```bash
      cp start-or-restart.sh.example start-or-restart.sh
      chmod +x start-or-restart.sh
      ```
  1. edit the runner script `start-or-restart.sh` to define the needed sensitive
     environmental variables
      ```bash
      vim start-or-restart.sh
      ```
  1. start the stack
      ```bash
      ./start-or-restart.sh
      # or if you need to force a rebuild of the 'curl-cron' and 'db-sync' images, which you should do after a `git pull`
      ./start-or-restart.sh --build
      # or if you don't want the ElasticSearch related infrastructure (like during dev)
      env NO_ES=1 ./start-or-restart.sh
      ```
  1. wait until the `db` container is up and running (shouldn't take long):
      ```console
      $ docker logs --tail 10 swarmrest_db
      PostgreSQL init process complete; ready for start up.

      2018-11-15 02:19:24.920 UTC [1] LOG:  listening on IPv4 address "0.0.0.0", port 5432
      2018-11-15 02:19:24.920 UTC [1] LOG:  listening on IPv6 address "::", port 5432
      2018-11-15 02:19:24.934 UTC [1] LOG:  listening on Unix socket "/var/run/postgresql/.s.PGSQL.5432"
      2018-11-15 02:19:24.964 UTC [70] LOG:  database system was shut down at 2018-11-15 02:19:24 UTC
      2018-11-15 02:19:24.976 UTC [1] LOG:  database system is ready to accept connections
      ```
  1. create a function that we need to build URLs in the JSON-LD data:
      ```bash
      ./set-hostname-for-jsonld.sh
      ```
  1. trigger a schema-only sync (should take less than a minute)
      ```bash
      ./helper-scripts/schema-only-sync.sh
      ```
  1. trigger a data sync to get us up and running (should take around a minute)
      ```bash
      ./helper-scripts/data-only-sync.sh
      ```
  1. connect as a superuser and run the `./script.sql` file to create all
     required objects for the API to run.  See section 'Modifying our copy of
     the schema' for more discussion about re-running.
      ```bash
      ./helper-scripts/recreate-api-views.sh
      ```
  1. look for the success output at the end of the script:
      ```
      outcome
      ---------
      success
      (1 row)
      ```
  1. if you're re-creating a prod instance, check the section below about
     restoring ES snapshots
  1. use the service
      ```bash
      curl -v '<hostname:port>/site?limit=1'
      # the response should be a JSON array of objects, e.g. [{"site_location_name":"...
      ```
  1. The Kibana dashboard is *NOT* open to the public by default, but assuming
     you have a way to connect to it, it's running on port 5601. This port can
     be changed in `.env`.

Warning: the Kibana (ELK stack) instance has no security/auth so **don't expose
it to the internet**. Or if you do, add some security. A nice way to connect to
the Kibana dashboard on a VM without opening the firewall is to use SSH local
port forwarding
(https://help.ubuntu.com/community/SSH/OpenSSH/PortForwarding#Local_Port_Forwarding).
For example, use the following to open port `30001` locally that tunnels to
`5601` (the Kibana port) on the remote server (replace with the real host):
```bash
ssh -nNT -L 30001:localhost:5601 ubuntu@<swarm-rest host>
```

## Running health check tests

There are some brief health check tests you can run against a live service to
make sure it's returning what you expect. First, make sure you satisfy the
requirements:

  1. python 2.7
  1. python `requests`

You can run it with:
```bash
./tests/tests.py <base URL>
```

For example, you could pass a URL like
```bash
./tests/tests.py http://swarmapi.ausplots.aekos.org.au
```

## Exposing unpublished data
The database will store *all* Ausplots data; both published and unpublished. The
flag for published is what this API needs to use to decide who gets access to
what.

We achieve this by creating DB views with a `_inc_unpub` suffix that include all
data. We then create another view on top with no suffix and this excludes the
unpublished data.

Now we can assign different auth roles to the different views. Have a look in
[`script.sql`](./script.sql) for the `GRANT SELECT ON...` statements (probably
near the bottom). You'll see the names of the roles that are given access to
each set of views.

Users with no auth, i.e. the public, will be identified by the role that is
configured as the anonymous role in
[`docker-compose.yml`](./docker-compose.yml). Look for the `PGRST_DB_ANON_ROLE`
env var for the postgREST service.

The way that users gain a higher authorization to access unpublished data is by
sending a JWT with their request. The JWT must include a `role` claim and the
value of `role` is what will be checked by postgREST to see if the user can
access a given view. Looking at those `GRANT` statements in `script.sql` again,
you'll see the name of the role that has access to the `_inc_unpub` views. The
other piece of the puzzle is that the JWT must be signed with a shared secret.
The value of this secret is configured by the `PGRST_JWT_SECRET` env var in
`docker-compose.yml`.

So with those `role` and `secret` values, you can generate a JWT to use as a
client to this service. At the time of writing, the ausplotsR client does it
[here](https://github.com/ternaustralia/ausplotsR/blob/820f235/R/ausplots_queries.r#L15)
(note: this link is pinned to a specific commit. Be sure to look at the latest
version of the code).

## Generating a JWT
If you need to generate a JWT, you can run the
[./helper-scripts/generate-jwt.sh]() script. It will read the values from the
code in the repo so you need to **run it on the swarm-rest server** so it uses
the real values.

The output of the script will give you the JWT and an example curl to test it
out.

## Modifying our copy of the schema
In the set up steps, we first sync the schema, then sync the data then run our
script to create the bits we need. Future data syncs won't touch the schema,
which means our script can make changes -- like adding row level security or
granting access -- to our copy of the schema. If you ever do another sync of the
schema, you *must* re-run the script. If re-running it doesn't work for any
reason, you can recover by killing the PG container and starting again:

  1. stop the stack
      ```bash
      docker-compose down
      ```
  1. destroy the volume from the postgres container
      ```bash
      docker volume rm swarm-rest_swarm-pgdata
      ```
  1. continue with the steps in the initial setup starting from running the
     `start-or-restart.sh` script

## Stopping the stack
The stack is designed to always keep running, even after a server restart, until
you manually stop it. The data for postgres and ElasticSearch are stored in
Docker data volumes. This means you can stop and destroy the stack, but **keep
the data** with:
```bash
docker-compose down
```

If you want to completely clean up and have the **data volumes also removed**,
you can do this with:
```bash
docker-compose down --volumes
```

## Creating a role in SWARM production to use for DB sync
Use these queries to create a user that you can use for the DB sync process:

```sql
CREATE ROLE syncuser PASSWORD 'somegoodpassword';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO syncuser;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO syncuser;
```

## Creating new tables in the source DB
If you see an error during the `pgsync` run that looks like:
```
Table does not exist in source: <some table>
```
...then it's probably a permissions thing. You can check by connecting to the
source DB using the credentials that this stack uses, and trying to select from
the table (assume the table is called `table_abc`):
```sql
SELECT * FROM table_abc;
ERROR:  permission denied for relation table_abc
```
This error is much clearer. To fix it, you need to connect to the source DB as
an admin and re-run the `GRANT` commands above.

## Manually triggering ElasticSearch snapshot
The snapshots happen regularly on a cron schedule but if you need to manually
trigger one by hand, you do so by running the script on the docker host:

```bash
./helper-scripts/trigger-es-s3-snapshot.sh
```

We rely on the ElasticSearch "S3 Repository Plugin" to give us the ability to
interact with AWS S3 for out snapshots.

## Restoring ElasticSearch snapshots

The name of the snapshot repo is defined in the `.env` file as
`ES_SNAPSHOT_REPO`. For this example, let's assume that it's `swarm-s3-backup`.
Also, as we don't expose the ES instance to the public internet, you'll need to
run these command on the docker host to have access (or through an SSH tunnel if
you're fancy).

  1. let's list all the available snapshots
      ```console
      $ curl 'http://localhost:9200/_snapshot/swarm-s3-backup/_all'
      [
        {
          "snapshot": "swarm-metrics.20181115_0903",
          "uuid": "XoHfmTbaROqgKlI0jvEWjw",
          "indices": [
            "swarm-rest",
            ".kibana"
          ],
          "state": "SUCCESS",
          "start_time": "2018-11-15T09:03:00.836Z",
          ...
        },
        ...
      ]
      ```
  1. pick a snapshot to restore, and let's restore it
      ```console
      $ curl -X POST 'http://localhost:9200/_snapshot/swarm-s3-backup/swarm-metrics.20181115_0903/_restore?wait_for_completion'
      {
        "snapshot": {
          "snapshot": "swarm-metrics.20181115_0903",
          "indices": [
            ".kibana",
            "swarm-rest"
          ],
          "shards": {
            "total": 6,
            "failed": 0,
            "successful": 6
          }
        }
      }
      ```
  1. if you get an error that indicies are already open, you can remove the ES
     container and its volume, then create a fresh one to start from a clean
     slate:
      ```bash
      docker rm -f swarmrest_elk
      docker volume rm swarm-rest_elk-data
      ./start-or-restart.sh
      docker logs --tail 10 -f swarmrest_elk # watch the logs until Kibana has started up
      # <control-c> to stop tailing logs...
      # ...then try the restore again
      ```

## Deleting old ElasticSearch snapshots
The high level approach is to list all the available snapshots, filter the list
down to the "old" ones, then delete all those snapshots by `curl`ing a DELETE
to a certain endpoint.

Run the script we have to help you with this:
```bash
./helper-scripts/delete-old-es-s3-snapshots.sh 2018
./helper-scripts/delete-old-es-s3-snapshots.sh 2019
```

## Connect to DB with psql
You can connect to the DB as the superuser if you SSH to the docker host, then
run:
```bash
./helper-scripts/psql.sh
```

## DB dump/restore
In normal operation, you won't have to do this because we are just a mirror for
the source of truth and don't create any new data. But for development, it's
nice to be able to work with DB dumps.

To create a backup/dump:
```bash
docker exec -i swarmrest_db sh -c 'pg_dump -v -Fc --exclude-schema=api -U $POSTGRES_USER -d $POSTGRES_DB' > swarmrest.backup
```

To restore a backup/dump:
```bash
docker exec -it swarmrest_db sh -c 'psql -U $POSTGRES_USER -d $POSTGRES_DB -c "DROP SCHEMA IF EXISTS api CASCADE;"'
cat swarmrest.backup | docker exec -i swarmrest_db sh -c 'pg_restore -v -U $POSTGRES_USER -d $POSTGRES_DB --clean --if-exists'
# now you need to run the script.sql again
```

## Cleaning the ElasticSearch index
If you find our metrics are polluted by HTTP requests that aren't real users,
you can use the `helper-scripts/clean-es-index.html` tool to help clean it.
Just open the file in your browser and it'll tell you what to do.

## Known problems
  1. Kibana has no auth so we can't open it to the public yet
  1. sometimes ES dies inside the ELK stack but Docker can't see it. We're using
     a health check and the autoheal container but as an alternative we could go
     for the official, separate images for Kibana and ES so they're PID 1 and
     can be monitored and bounced by docker if they die.
  1. consider adding fail2ban to the stack to help nginx provide protection.
     Maybe something like https://github.com/crazy-max/docker-fail2ban but that
     writes error.log to stderr so that needs to be piped into file too so f2b
     can read it.

