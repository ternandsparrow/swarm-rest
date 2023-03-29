#!/bin/sh
: ${TARGET_SERVER:?downstream server scheme, host and port to sends proxied requests to}
: ${DNS_NAME:?public DNS hostname this server should respond to}

upstreamTimeout=${UPSTREAM_TIMEOUT:-300}
cacheZoneName='STATIC'
cacheSwitchFragment=$cacheZoneName
if [ ! -z "$NO_CACHE" ]; then
  echo "[INFO] running WITHOUT a cache for nginx, as requested by NO_CACHE env var"
  cacheSwitchFragment='off'
fi
confpath=/etc/nginx/nginx.conf
cachedir=/tmp/nginx/cache
mkdir -p $cachedir
cat << EOF > $confpath

worker_processes 1;

events { worker_connections 1024; }

http {

    # Increase buffer size to allow for large query strings (like a list of all sites). This should handle a query string up to ~32k
    # thanks https://stackoverflow.com/a/27551259/1410035
    proxy_buffer_size   128k;
    proxy_buffers   4 256k;
    proxy_busy_buffers_size   256k;
    # thanks https://stackoverflow.com/a/1067462/1410035
    large_client_header_buffers 4 256k;

    proxy_cache_path $cachedir levels=1:2 keys_zone=$cacheZoneName:10m inactive=10m max_size=1g;

    # Looking to fix overloading the DB with 503's being thrown
    # thanks github https://github.com/PostgREST/postgrest/issues/1399#issuecomment-843174952
    upstream target-server {
        server $TARGET_SERVER;
        keepalive 64;
        keepalive_timeout 120s;
    }

    upstream metadata-server {
        server $METADATA_SERVER;
    }

    limit_req_zone \$binary_remote_addr zone=mylimit:10m rate=${RATE_LIMIT:-5r/s};

    # default server to catch unmatching requests, and reject them!
    server {
        listen 80;
        return 404;
    }

    server {
        listen 80;
        server_name $DNS_NAME
                    localhost
                    ;

        location ~ \.php {
            deny all;
        }

        location = /metadata-dictionary.json {
            proxy_pass         http://metadata-server;
            rewrite            /(.*) / break;
            proxy_redirect     off;
            proxy_set_header   Host \$host;
            proxy_set_header   X-Real-IP \$remote_addr;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Host \$server_name;

            limit_except GET {
                deny all;
            }
        }

        location / {
            limit_req zone=mylimit burst=${BURST_LIMIT:-20} nodelay;
            proxy_pass              http://target-server;
            proxy_redirect          off;
            proxy_cache             $cacheSwitchFragment;
            proxy_cache_valid       any 120m;
            proxy_cache_use_stale   error timeout http_500 http_502 http_503 http_504;
            proxy_cache_background_update on;
            proxy_cache_key         \$scheme\$proxy_host\$request_uri\$is_args\$args\$http_accept\$http_authorization; # add Accept and Auth header to key
            proxy_set_header        Host \$host;
            proxy_set_header        X-Real-IP \$remote_addr;
            proxy_set_header        X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header        X-Forwarded-Host \$server_name;
            proxy_connect_timeout   $upstreamTimeout;
            proxy_send_timeout      $upstreamTimeout;
            proxy_read_timeout      $upstreamTimeout;
            send_timeout            $upstreamTimeout;

            add_header              X-Nginx-Cache-Status \$upstream_cache_status;

            limit_except GET {
                deny all;
            }
        }
    }
}
EOF

echo "[INFO] using $confpath"
cat $confpath

nginx -g "daemon off;"
