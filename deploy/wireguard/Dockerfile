# WireGuard-Fernwartungsnetz der Stromkreis-Gateways, als Container im
# Compose-Stack (statt nativ wie bei ISCHLSTROM auf s1). Braucht NET_ADMIN
# und das wireguard-Kernelmodul des Hosts (Linux ab 5.6 eingebaut).
#
# microsocks reicht der Plattform TCP ins Wartungsnetz durch (SSH-Konsole
# der Anlagen-Detailseite); Alpine hat kein Paket dafuer, deshalb wird es
# hier aus den Quellen gebaut (gepinnte Version, statisch, ~100 KB).
FROM alpine:3.20 AS microsocks
RUN apk add --no-cache build-base curl \
 && curl -fsSL https://github.com/rofl0r/microsocks/archive/refs/tags/v1.0.5.tar.gz | tar -xz \
 && make -C microsocks-1.0.5 CFLAGS="-O2 -static"

FROM alpine:3.20
RUN apk add --no-cache wireguard-tools iproute2 curl jq openssh-client
COPY --from=microsocks /microsocks-1.0.5/microsocks /usr/local/bin/microsocks
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
ENTRYPOINT ["/entrypoint.sh"]
