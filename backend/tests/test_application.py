from graphy.application import (
    BackendConfig,
    Conversation,
    Event,
    EventCollector,
    Health,
    MessageComposer,
    Phase,
)


def test_domain_objects_and_composer():
    config = BackendConfig(base_url='http://localhost/api/v1', token='x')
    assert config.url('/health') == 'http://localhost/api/v1/health'
    assert config.headers()['Authorization'] == 'Bearer x'
    assert Health.from_json({'ok': True, 'protocol': 1, 'version': '0.3', 'engine': 'rust'}).native
    text, paths = MessageComposer().add('Explain').attach('notes.md').build()
    assert text == 'Explain' and paths == ('notes.md',)
    assert Phase.TEACHING.value == 'teaching'


def test_event_collector_and_conversation():
    collector = EventCollector()
    collector.add(Event.from_json({'type': 'text_delta', 'delta': 'Hello', 'seq': 1}))
    collector.add(Event.from_json({'type': 'message_end', 'message': {'content': 'Hello'}, 'seq': 2}))
    assert collector.text == 'Hello' and collector.completed
    conversation = Conversation.from_json({'id': 's', 'course_id': 'c', 'name': 'N', 'model': 'm', 'messages': [{'role': 'assistant', 'content': 'Hi'}], 'learning': {'phase': 'teaching'}})
    assert conversation.last_assistant.content == 'Hi' and conversation.phase is Phase.TEACHING
