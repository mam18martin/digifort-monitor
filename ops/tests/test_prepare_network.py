import importlib.util
import ipaddress
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('prepare_network', Path(__file__).parents[1] / 'prepare_network.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class NetworkPlanTests(unittest.TestCase):
    def setUp(self):
        self.plan = {
            'ipam_approval': 'SYNTHETIC-TEST-ONLY',
            'docker0_bip': '192.168.240.1/24', 'monitor_subnet': '192.168.241.0/27',
            'default_pool_base': '192.168.242.0/23', 'default_pool_size': 27,
        }

    def test_unapproved_example_is_rejected(self):
        self.plan['ipam_approval'] = None
        with self.assertRaises(ValueError):
            module.validate_plan(self.plan, [])

    def test_disjoint_candidate_and_default_route(self):
        self.assertEqual(str(module.validate_plan(self.plan, [ipaddress.ip_network('0.0.0.0/0')])[1]), '192.168.241.0/27')

    def test_local_route_or_broad_corporate_reservation_blocks(self):
        for cidr in ['192.168.241.0/24', '192.168.0.0/16']:
            with self.assertRaises(ValueError):
                module.validate_plan(self.plan, [ipaddress.ip_network(cidr)])

    def test_proposed_overlap_is_rejected(self):
        self.plan['monitor_subnet'] = '192.168.240.0/27'
        with self.assertRaises(ValueError):
            module.validate_plan(self.plan, [])

    def test_no_assumption_that_ten_networks_are_free(self):
        self.plan['monitor_subnet'] = '10.123.4.0/27'
        with self.assertRaises(ValueError):
            module.validate_plan(self.plan, [ipaddress.ip_network('10.0.0.0/8')])

    def test_public_range_and_network_gateway_are_rejected(self):
        for value in ['192.0.2.1/24', '192.168.240.0/24']:
            self.plan['docker0_bip'] = value
            with self.assertRaises(ValueError):
                module.validate_plan(self.plan, [])


if __name__ == '__main__':
    unittest.main()
