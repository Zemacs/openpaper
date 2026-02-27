import ipaddress
import os
import socket
from urllib.parse import urlparse


DEFAULT_ALLOWED_PRIVATE_RESOLUTION_CIDRS = ("198.18.0.0/15",)


def _load_allowed_private_resolution_networks() -> list[ipaddress._BaseNetwork]:
    raw = (os.getenv("URL_SAFETY_ALLOWED_PRIVATE_CIDRS") or "").strip()
    values = [item.strip() for item in raw.split(",") if item.strip()]
    if not values:
        values = list(DEFAULT_ALLOWED_PRIVATE_RESOLUTION_CIDRS)

    networks: list[ipaddress._BaseNetwork] = []
    for value in values:
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    return networks


def _is_ip_literal(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return False


def _is_allowed_private_resolution_ip(host_or_ip: str) -> bool:
    try:
        ip = ipaddress.ip_address(host_or_ip)
    except ValueError:
        return False

    for network in _load_allowed_private_resolution_networks():
        if ip in network:
            return True
    return False


def _is_non_public_ip(host_or_ip: str) -> bool:
    try:
        ip = ipaddress.ip_address(host_or_ip)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("Only http/https URLs are supported.")

    hostname = (parsed.hostname or "").strip()
    if not hostname:
        raise ValueError("URL host is missing.")

    lowered = hostname.lower()
    if lowered in {"localhost", "127.0.0.1", "::1"}:
        raise ValueError("Localhost URLs are not allowed.")

    if _is_ip_literal(hostname):
        if _is_non_public_ip(hostname):
            raise ValueError("Private or non-public IP addresses are not allowed.")
        return

    if _is_non_public_ip(hostname):
        raise ValueError("Private or non-public IP addresses are not allowed.")

    try:
        infos = socket.getaddrinfo(hostname, parsed.port or None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ValueError("Could not resolve URL host.") from exc

    resolved_ips = {
        str(info[4][0])
        for info in infos
        if info and len(info) > 4 and info[4]
    }
    if not resolved_ips:
        raise ValueError("Could not resolve URL host.")

    if any(_is_non_public_ip(ip) for ip in resolved_ips):
        for ip in resolved_ips:
            if _is_non_public_ip(ip) and not _is_allowed_private_resolution_ip(ip):
                raise ValueError("Resolved host maps to a private or non-public IP.")
