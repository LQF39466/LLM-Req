"""Standard-library client for the local LLM job service (Python 3.9+)."""
import http.client
import json
import time
from urllib.parse import urlsplit, quote


class LLMJobs:
    def __init__(self, base_url="http://127.0.0.1:3210", timeout=180):
        url = urlsplit(base_url)
        if url.scheme != "http" or url.hostname not in ("localhost", "127.0.0.1"):
            raise ValueError("This client targets a local HTTP service only")
        self.host, self.port, self.timeout = url.hostname, url.port or 3210, timeout

    def _connection(self):
        return http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)

    @staticmethod
    def _json_response(response):
        data = json.loads(response.read())
        if response.status >= 400:
            raise RuntimeError(f"HTTP {response.status}: {data.get('error', data)}")
        return data

    def _submit(self, chunks):
        conn = self._connection()
        try:
            try:
                conn.request(
                    "POST", "/api/jobs", body=chunks,
                    headers={"Content-Type": "application/x-ndjson"},
                    encode_chunked=True,
                )
            except OSError as send_error:
                # The server may reject the JSONL header while queries are still uploading.
                # Read its response instead of masking a useful HTTP 400 with BrokenPipeError.
                # Never resend: a missing acknowledgement does not prove import failed.
                try:
                    response = conn.getresponse()
                except (OSError, http.client.HTTPException):
                    raise send_error
            else:
                response = conn.getresponse()
            return self._json_response(response)["id"]
        finally:
            conn.close()

    def submit(self, *, name, batches, queries, submission_key=None):
        """batches is a small config list; queries may be a lazy generator."""
        def chunks():
            header = {"name": name, "batches": batches}
            if submission_key is not None:
                header["submissionKey"] = submission_key
            yield (json.dumps(header, ensure_ascii=False) + "\n").encode("utf-8")
            # Coalesce small queries to avoid one TCP write per row.
            buffer = bytearray()
            for query in queries:
                buffer.extend((json.dumps(query, ensure_ascii=False) + "\n").encode("utf-8"))
                if len(buffer) >= 64 * 1024:
                    yield bytes(buffer)
                    buffer.clear()
            if buffer:
                yield bytes(buffer)
        return self._submit(chunks())

    def submit_file(self, path):
        """Stream an existing JSONL file without loading it into memory."""
        with open(path, "rb") as source:
            return self._submit(iter(lambda: source.read(64 * 1024), b""))

    def status(self, job_id):
        conn = self._connection()
        try:
            conn.request("GET", "/api/jobs/" + quote(job_id, safe=""))
            return self._json_response(conn.getresponse())
        finally:
            conn.close()

    def wait(self, job_id, interval=2):
        """Return when finished, paused, or requiring human attention."""
        while True:
            status = self.status(job_id)
            if status["state"] in ("completed", "needs_attention", "preflight_blocked", "paused"):
                return status
            time.sleep(interval)

    def results(self, job_id):
        """Iterate JSONL results. Wait for completion for a final snapshot."""
        conn = self._connection()
        try:
            conn.request("GET", "/api/jobs/" + quote(job_id, safe="") + "/export")
            response = conn.getresponse()
            if response.status >= 400:
                self._json_response(response)
            for line in response:
                if line.strip():
                    yield json.loads(line)
        finally:
            conn.close()
