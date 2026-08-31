"""Recursive traversal shared by the endless-mode evidence readers."""


def walk(node):
    """Yield *node* and every value nested below it."""
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)
