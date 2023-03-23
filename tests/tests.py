#!/usr/bin/python
# Runs tests against a live service to assert things are healthy
import re
import unittest
import argparse
import requests


def get_base_url():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        'base_url', help='base URL of the API to test, e.g. http://swarmapi.ausplots.aekos.org.au:3000')
    args = parser.parse_args()
    result = args.base_url
    print('Using base URL of %s' % result)
    return result


BASE_URL = get_base_url()


class TestUM(unittest.TestCase):

    def test_swagger_01(self):
        '''Does the swagger endpoint work?'''
        the_root = ''
        body = get_json(the_root)
        self.assertEqual(body['swagger'], '2.0')

    def test_site_01(self):
        '''Is the /site endpoint returning the expected number of fields?'''
        item = get_single_element_json('site', 41, self)
        self.assertTrue(item['established_date'])

    def test_site_02(self):
        '''Is the endpoint with unpublished data protected?'''
        resp = requests.get(build_url('site_inc_unpub'))
        self.assertEqual(resp.status_code, 401)

    def test_structural_summary_01(self):
        '''Is the /structural_summary endpoint returning the expected number of fields?'''
        item = get_single_element_json('structural_summary', 14, self)
        self.assertTrue(item['phenology_comment'])

    def test_soil_bulk_density_01(self):
        '''Is the /soil_bulk_density endpoint returning the expected number of fields?'''
        item = get_single_element_json('soil_bulk_density', 14, self)
        self.assertTrue(item['sample_id'])

    def test_soil_characterisation_01(self):
        '''Is the /soil_characterisation endpoint returning the expected number of fields?'''
        item = get_single_element_json('soil_characterisation', 33, self)
        try:
            float(item['upper_depth'])
        except TypeError:
            self.fail('upper_depth is not a number')

    def test_soil_subsite_01(self):
        '''Is the /soil_subsite endpoint returning the expected number of fields?'''
        item = get_single_element_json('soil_subsite', 11, self)
        self.assertTrue(item['subsite_id'])

    def test_veg_voucher_01(self):
        '''Is the /veg_voucher endpoint returning the expected number of fields?'''
        item = get_single_element_json('veg_voucher', 26, self)
        self.assertTrue(item['veg_barcode'])

    def test_veg_pi_01(self):
        '''Is the /veg_pi endpoint returning the expected number of fields?'''
        item = get_single_element_json('veg_pi', 26, self)
        self.assertIsNotNone(item['point_number'])

    def test_veg_basal_01(self):
        '''Is the /veg_basal endpoint returning the expected number of fields?'''
        item = get_single_element_json('veg_basal', 24, self)
        self.assertTrue(item['basal_area'])


def build_url(suffix):
    return '%s/%s' % (BASE_URL, suffix)


def get_json(suffix, params={}):
    resp = requests.get(build_url(suffix), params)
    resp.raise_for_status()
    body = resp.json()
    return body


def get_single_element_json(suffix, expected_field_count, unittest_self):
    body = get_json(suffix, params={'limit': '1'})
    unittest_self.assertEqual(len(body), 1)
    element1 = body[0]
    unittest_self.assertEqual(len(
        element1), expected_field_count, msg='Expected number of fields did not match')
    unittest_self.assertTrue(re.match(
        '\w{6}\d{4}$', element1['site_location_name']), msg='Incorrect format for site_location_name')
    return element1


if __name__ == '__main__':
    suite = unittest.TestLoader().loadTestsFromTestCase(TestUM)
    unittest.TextTestRunner(verbosity=2).run(suite)
