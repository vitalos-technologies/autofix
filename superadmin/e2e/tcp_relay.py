"""CI only: forward 127.0.0.1:<listen> to <host>:<port> inside a container's network namespace.

The production image refuses a plain-text Autofix database unless it is on localhost. In CI the local
Supabase runs in another container, so the app container shares this relay's network namespace and
reaches Supabase at 127.0.0.1, as the production check expects.

    python tcp_relay.py 55432 supabase_db_<project>:5432
"""

import asyncio
import sys


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    finally:
        writer.close()


async def main(listen: int, host: str, port: int) -> None:
    async def handle(client_reader, client_writer):
        try:
            upstream_reader, upstream_writer = await asyncio.open_connection(host, port)
        except OSError:
            client_writer.close()
            return
        await asyncio.gather(
            pipe(client_reader, upstream_writer), pipe(upstream_reader, client_writer), return_exceptions=True
        )

    server = await asyncio.start_server(handle, "127.0.0.1", listen)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    target_host, target_port = sys.argv[2].rsplit(":", 1)
    asyncio.run(main(int(sys.argv[1]), target_host, int(target_port)))
