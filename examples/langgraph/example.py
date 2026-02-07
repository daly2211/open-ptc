"""
LangGraph + open-codemode example.

Connects to the open-codemode WebSocket server, registers Python functions,
and creates an agent that executes TypeScript in a sandbox — calling your
functions back over the WebSocket connection.

Prerequisites:
    1. Start the servers:  deno task start  (or docker-compose up)
    2. Set OPENAI_API_KEY (or your provider's key) in .env
    3. pip install -r requirements.txt
"""

import os

from dotenv import load_dotenv
from langchain.agents import create_agent
from langchain.chat_models import init_chat_model

from repl_tool import repl_tool

load_dotenv()

WS_URL = os.getenv("WS_SERVER_URL", "ws://localhost:9733")


# -- Define plain Python functions (no @tool decorator) -----------------------

def get_temperature(city: str) -> float:
    """Get the current temperature for a city in Fahrenheit.

    Args:
        city: City name to look up
    """
    temps = {"NYC": 72.0, "LA": 85.0, "Chicago": 65.0}
    return temps.get(city, 70.0)


def convert_temp(fahrenheit: float, to_unit: str) -> float:
    """Convert temperature from Fahrenheit to another unit.

    Args:
        fahrenheit: Temperature in Fahrenheit
        to_unit: Target unit — 'celsius' or 'kelvin'
    """
    if to_unit == "celsius":
        return round((fahrenheit - 32) * 5 / 9, 1)
    if to_unit == "kelvin":
        return round((fahrenheit - 32) * 5 / 9 + 273.15, 1)
    return fahrenheit


def calculate(a: float, b: float, operation: str) -> float:
    """Perform a mathematical operation on two numbers.

    Args:
        a: First number
        b: Second number
        operation: One of add, subtract, multiply, divide
    """
    ops = {
        "add": lambda x, y: x + y,
        "subtract": lambda x, y: x - y,
        "multiply": lambda x, y: x * y,
        "divide": lambda x, y: x / y if y != 0 else float("inf"),
    }
    return ops.get(operation, lambda x, y: 0)(a, b)


# -- Agent setup & run --------------------------------------------------------

if __name__ == "__main__":
    model = init_chat_model(
        model=os.getenv("MODEL_NAME", "gpt-4"),
        model_provider=os.getenv("MODEL_PROVIDER", "openai"),
        temperature=0,
    )

    agent = create_agent(
        model,
        tools=[repl_tool([get_temperature, convert_temp, calculate], ws_url=WS_URL)],
    )

    result = agent.invoke(
        {"messages": [("user", "What's the temperature in NYC in Celsius?")]},
        config={"recursion_limit": 10},
    )

    print(result["messages"][-1].content)
