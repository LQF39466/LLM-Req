"""Run after configuring .env and starting the JS service.

This example submits two real LLM requests and can incur API charges.
"""
from python_client import LLMJobs


def main():
    client = LLMJobs()
    job_id = client.submit(
        name="Python 批量请求示例",
        submission_key="python-example-001",
        config={"provider": "deepseek", "model": "deepseek-flash", "maxOutputTokens": 2048},
        queries=["用一句话解释 SQLite WAL。", "用一句话解释指数退避。"],
    )
    print("Job:", job_id)
    print("控制台: http://127.0.0.1:3210")
    print("状态:", client.wait(job_id)["state"])
    for result in client.results(job_id):
        print(result["query_id"], result["state"], result["result"])


if __name__ == "__main__":
    main()
