import os
from openai import OpenAI
from cdwv import wv

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))


@wv.op
def ask(prompt, system="You are a helpful assistant."):
    response = client.responses.create(
        model="gpt-4.1",
        instructions=system,
        input=prompt,
    )
    return response.output_text


@wv.op
def summarize(text):
    response = client.responses.create(
        model="gpt-4.1",
        instructions="Summarize the following text in one sentence.",
        input=text,
    )
    return response.output_text


@wv.op
def translate(text, language):
    response = client.responses.create(
        model="gpt-4.1",
        instructions=f"Translate the following text to {language}. Reply with only the translation.",
        input=text,
    )
    return response.output_text


@wv.op
def classify_sentiment(text):
    response = client.responses.create(
        model="gpt-4.1",
        instructions="Classify the sentiment of the text as positive, negative, or neutral. Reply with one word only.",
        input=text,
    )
    return response.output_text


@wv.op
def broken_call(prompt):
    # This will raise — bad model name — so we get an error trace
    response = client.responses.create(
        model="gpt-999-fake",
        instructions="You are helpful.",
        input=prompt,
    )
    return response.output_text


# --- run a bunch of calls ---

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
