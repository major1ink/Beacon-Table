# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

ARG VERSION=dev
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/beacon-table ./cmd/beacon-table

FROM alpine:3.20
# Сертификаты нужны для исходящих запросов: импорт модулей Foundry по https.
RUN apk add --no-cache ca-certificates tzdata \
    && adduser -D -u 10001 beacon

COPY --from=build /out/beacon-table /usr/local/bin/beacon-table

ENV BEACON_DATA_DIR=/data \
    BEACON_UPLOADS_DIR=/uploads \
    BEACON_ADDR=:8080
RUN mkdir -p /data /uploads && chown beacon:beacon /data /uploads
VOLUME ["/data", "/uploads"]

USER beacon
EXPOSE 8080

# /healthz отвечает 503, если база не откликнулась (см. health_handlers.go),
# поэтому docker видит разницу между «процесс жив» и «сервер работает».
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1

ENTRYPOINT ["beacon-table"]
