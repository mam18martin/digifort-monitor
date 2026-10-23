"""Prepare private files only; never apply daemon settings or change routes."""
import argparse
import ipaddress
import json
import os
from pathlib import Path
import stat
import subprocess

PRIVATE_RANGES = [ipaddress.ip_network(value) for value in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')]


def validate_plan(plan, observed):
    if not isinstance(plan.get('ipam_approval'), str) or not plan['ipam_approval'].strip():
        raise ValueError('IPAM approval reference required')
    bridge = ipaddress.ip_interface(plan['docker0_bip'])
    monitor = ipaddress.ip_network(plan['monitor_subnet'], strict=True)
    pool = ipaddress.ip_network(plan['default_pool_base'], strict=True)
    networks = [bridge.network, monitor, pool]
    if any(net.version != 4 or not any(net.subnet_of(private) for private in PRIVATE_RANGES) for net in networks):
        raise ValueError('Only approved RFC1918 IPv4 networks are supported')
    if bridge.ip in (bridge.network.network_address, bridge.network.broadcast_address):
        raise ValueError('Bridge gateway must be a usable host address')
    size = plan['default_pool_size']
    if type(size) is not int or not pool.prefixlen <= size <= 29:
        raise ValueError('Invalid default network prefix size')
    if any(left.overlaps(right) for i, left in enumerate(networks) for right in networks[i + 1:]):
        raise ValueError('Proposed networks overlap each other')
    for net in networks:
        if any(other.version == 4 and other.prefixlen != 0 and net.overlaps(other) for other in observed):
            raise ValueError('Proposed range overlaps observed routes or Docker networks')
    return bridge, monitor, pool


def observed_networks():
    result = []
    routes = json.loads(subprocess.check_output(['ip', '-j', 'route', 'show', 'table', 'all'], text=True))
    for route in routes:
        destination = route.get('dst')
        if destination and destination != 'default':
            result.append(ipaddress.ip_network(destination, strict=False))
    interfaces = json.loads(subprocess.check_output(['ip', '-j', 'address', 'show'], text=True))
    for interface in interfaces:
        for address in interface.get('addr_info', []):
            result.append(ipaddress.ip_network(f"{address['local']}/{address['prefixlen']}", strict=False))
    ids = subprocess.check_output(['docker', 'network', 'ls', '-q'], text=True).split()
    if ids:
        networks = json.loads(subprocess.check_output(['docker', 'network', 'inspect', *ids], text=True))
        for network in networks:
            for config in network.get('IPAM', {}).get('Config') or []:
                if config.get('Subnet'):
                    result.append(ipaddress.ip_network(config['Subnet'], strict=False))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--current-daemon', default='/etc/docker/daemon.json')
    args = parser.parse_args()
    try:
        plan = json.loads(Path(args.plan).read_text())
        bridge, monitor, pool = validate_plan(plan, observed_networks())
        output = Path(args.output_dir).resolve()
        repo = Path(__file__).resolve().parents[1]
        if output.is_relative_to(repo) or any(output.is_relative_to(Path(root)) for root in ('/etc', '/proc', '/sys', '/dev', '/run')):
            raise ValueError('Output must be a private staging directory outside source and system configuration')
        if not output.is_dir() or output.stat().st_uid != os.getuid() or stat.S_IMODE(output.stat().st_mode) != 0o700:
            raise ValueError('Output directory must be owned by the operator with mode 0700')
        source = Path(args.current_daemon)
        daemon = json.loads(source.read_text()) if source.exists() else {}
        daemon.update({'bip': str(bridge), 'default-address-pools': [{'base': str(pool), 'size': plan['default_pool_size']}]})
        files = {
            'daemon.json': json.dumps(daemon, indent=2) + '\n',
            'network.env': f'MONITOR_SUBNET={monitor}\n',
        }
        if any((output / name).exists() for name in files):
            raise ValueError('Staging files already exist; review instead of overwriting')
        for name, content in files.items():
            descriptor = os.open(output / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with os.fdopen(descriptor, 'w') as stream:
                stream.write(content)
        print('Preparación completada; no se aplicaron cambios de red.')
    except (ValueError, KeyError, TypeError, OSError, subprocess.CalledProcessError):
        parser.exit(1, 'Preparación bloqueada: revisar aprobación, rangos, permisos y superposiciones sin publicar datos privados.\n')


if __name__ == '__main__':
    main()
