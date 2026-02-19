import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'real_weave/weave'))

import weave
from weave.trace_server_bindings.jsonl_logging_trace_server import attach_jsonl_logger

client = weave.init("cd-weave-demo")
log_path = attach_jsonl_logger(client)
print(f"Logging to: {log_path}\n")


@weave.op
def ask(prompt: str, system: str = "You are a helpful assistant.") -> str:
    from openai import OpenAI
    c = OpenAI()
    response = c.responses.create(
        model="gpt-4.1",
        instructions=system,
        input=prompt,
    )
    return response.output_text


@weave.op
def summarize(text: str) -> str:
    from openai import OpenAI
    c = OpenAI()
    response = c.responses.create(
        model="gpt-4.1",
        instructions="Summarize the following text in one sentence.",
        input=text,
    )
    return response.output_text


@weave.op
def translate(text: str, language: str) -> str:
    from openai import OpenAI
    c = OpenAI()
    response = c.responses.create(
        model="gpt-4.1",
        instructions=f"Translate the following text to {language}. Reply with only the translation.",
        input=text,
    )
    return response.output_text


@weave.op
def classify_sentiment(text: str) -> str:
    from openai import OpenAI
    c = OpenAI()
    response = c.responses.create(
        model="gpt-4.1",
        instructions="Classify the sentiment of the text as positive, negative, or neutral. Reply with one word only.",
        input=text,
    )
    return response.output_text


@weave.op
def broken_call(prompt: str) -> str:
    from openai import OpenAI
    c = OpenAI()
    response = c.responses.create(
        model="gpt-999-fake",
        instructions="You are helpful.",
        input=prompt,
    )
    return response.output_text


answer = ask("What is the capital of France?")
print("ask:", answer)

pirate_answer = ask(
    "How do I check if a Python object is an instance of a class?",
    system="You are a coding assistant that talks like a pirate.",
)
print("pirate ask:", pirate_answer)

summary = summarize(answer)
print("summarize:", summary)

translation = translate("Hello, how are you?", "Spanish")
print("translate:", translation)

sentiment1 = classify_sentiment("I love this, it's amazing!")
print("sentiment (positive):", sentiment1)

sentiment2 = classify_sentiment("This is terrible and I hate it.")
print("sentiment (negative):", sentiment2)

sentiment3 = classify_sentiment("The package arrived on Tuesday.")
print("sentiment (neutral):", sentiment3)

try:
    broken_call("This will fail")
except Exception as e:
    print("broken_call error (expected):", type(e).__name__)

weave.finish()
print(f"\nDone. Run file: {log_path}")
