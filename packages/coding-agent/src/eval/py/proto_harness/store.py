"""Session-owned rich values. Each commit replaces one graph using revision CAS."""
from collections.abc import MutableMapping
from contextlib import contextmanager
from . import _client
from . import _serialization


class Store(MutableMapping):
    def __init__(self):
        self._graph = None
        self._revision = 0
        self._batch = False

    def refresh(self):
        result = _client.request("store.get_graph", {})
        graph = {} if result["graph"] is None else _serialization.loads(result["graph"])
        if not isinstance(graph, dict):
            raise ValueError("Store graph is not a mapping")
        self._graph, self._revision = graph, result["revision"]
        return self

    def _mapping(self):
        if self._graph is None:
            self.refresh()
        return self._graph

    @property
    def revision(self):
        self._mapping()
        return self._revision

    def commit(self):
        graph = _serialization.dumps(self._mapping())
        result = _client.request("store.put_graph", {"expected_revision": self._revision, "graph": graph})
        self._revision = result["revision"]
        return self._revision

    def __getitem__(self, key):
        return self._mapping()[key]

    def __setitem__(self, key, value):
        self._mapping()[key] = value
        if not self._batch:
            self.commit()

    def __delitem__(self, key):
        del self._mapping()[key]
        if not self._batch:
            self.commit()

    def __iter__(self):
        return iter(self._mapping())

    def __len__(self):
        return len(self._mapping())

    @contextmanager
    def transaction(self):
        if self._batch:
            raise RuntimeError("Nested store transactions are unsupported")
        self._mapping()
        self._batch = True
        try:
            yield self
            self.commit()
        finally:
            self._batch = False


store = Store()
