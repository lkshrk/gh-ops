FROM oven/bun:1-distroless

WORKDIR /app

COPY pr-dashboard ./pr-dashboard

USER 65532:65532

EXPOSE 3000

CMD ["pr-dashboard/server.js"]
