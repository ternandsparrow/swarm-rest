import json
import time
import threading
import os
from datetime import datetime
from urllib.parse import urlparse
from mitmproxy import ctx
from elasticsearch import Elasticsearch

try:
    es_url = os.environ['ES_URL']
except KeyError:
    es_url = 'localhost:9200'

try:
    es_index = os.environ['INDEX_NAME']
except KeyError:
    es_index = 'ausplots_r'

ctx.log.warn("""Runtime config:
    ElasticSearch URL: {es_url}
    ElasticSearch index: {es_index}""".format(es_url=es_url, es_index=es_index))

es = Elasticsearch([es_url])

def log_to_elasticsearch(msg):
    msg['eventDate'] = datetime.now()
    try:
        # print('Logging message: %s' % str(msg)) # FIXME add configurable python logging
        # remove deprecated args
        resp = es.index(index=es_index, body=msg)
    except Exception as e:
        print('[ERROR] Failed to store metric in ES: ', e)


def count_sites(body):
    site_count = 0
    seen_sites = {}
    for curr in body:
        try:
            key = str(curr['site_location_name'])
        except KeyError:
            # user probably used ?select= query param and didn't include site_location_name
            continue
        try:
            seen_sites[key]
            continue
        except KeyError:
            seen_sites[key] = True
            site_count += 1
    return site_count


class MetricsLogger:
    def response(self, flow):
        if flow.response.status_code is not 200:
            ctx.log.info('ignoring reponse with non 200 status')
            return
        try:
            body_json = json.loads(flow.response.content)
        except json.decoder.JSONDecodeError:
            ctx.log.info('ignoring response that is not JSON')
            return
        if not isinstance(body_json, list):
            ctx.log.info('ignoring response that is JSON but not an array')
            return
        parsed_url = urlparse(flow.request.url)
        try:
            # for when we're running behind nginx
            remote_addr = flow.request.headers['x-real-ip']
        except KeyError:
            remote_addr = flow.client_conn.address[0]
        query_params = ''
        if parsed_url.query:
            query_params = '?' + parsed_url.query
        metric = {
            'resource': parsed_url.path,
            'url': '%s%s' % (parsed_url.path, query_params),
            'remoteAddr': remote_addr,
            'userAgent': flow.request.headers['user-agent'],
            'recordCount': len(body_json),
            'siteCount': count_sites(body_json)
        }
        thread = threading.Thread(target=log_to_elasticsearch, args=(metric,))
        thread.start()


addons = [
    MetricsLogger()
]
