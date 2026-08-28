# WireGuard-Fernwartungsnetz der Stromkreis-Gateways, als Container im
# Compose-Stack (statt nativ wie bei ISCHLSTROM auf s1). Braucht NET_ADMIN
# und das wireguard-Kernelmodul des Hosts (Linux ab 5.6 eingebaut).
FROM alpine:3.20
RUN apk add --no-cache wireguard-tools iproute2 curl jq openssh-client
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
