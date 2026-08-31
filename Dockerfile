FROM golang:1.25-alpine AS build
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/beacon-table ./cmd/beacon-table

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
ENTRYPOINT ["beacon-table"]
