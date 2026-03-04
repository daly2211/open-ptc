"""
LangGraph integration for Open-PTC.

Provides bidirectional tool calling between LangGraph agents
and the Open-PTC WebSocket execution environment.
"""

from .repl_tool import repl_tool, create_repl_tool

__all__ = ["repl_tool", "create_repl_tool"]
__version__ = "1.0.0"
