FROM python:3.7-alpine3.8
LABEL maintainer="Tom Saleeba"
ENV LISTEN_PORT 80
EXPOSE $LISTEN_PORT
RUN mkdir /app
WORKDIR /app
ADD entrypoint.sh log-metrics.py requirements.txt ./
RUN \
  apk add \
    openssl-dev && \
  apk add --no-cache --virtual .build-deps \
    gcc \
    python3-dev \
    musl-dev \
    libstdc++ \
    g++ \
    libffi-dev && \
  pip install cffi && \
  pip install -r requirements.txt && \
  apk del .build-deps
ENTRYPOINT ["/bin/sh", "entrypoint.sh"]

