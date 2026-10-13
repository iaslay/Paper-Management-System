"""验证论文讨论、多轮快照、来源、任务隔离及聊天卡片人工确认。"""
import json
import uuid
import pytest
from sqlalchemy import select, func
from app.models import DiscussionSession, DiscussionMessage, GenerationTask, ModelCall, CardVersion, PaperCard, Note
from app.ai_provider import VisionProvider
import httpx
from test_ai_cards import client, configure, run_task, wire, manual, card_state
from test_management import upload


def rid(): return uuid.uuid4().hex


def new_session(client, paper):
    response = client.post(f"/api/v1/papers/{paper['id']}/discussions", json={"request_id": rid(), "file_hash": paper["file_hash"]})
    assert response.status_code == 200, response.text
    return response.json()


def request(paper, **changes):
    return {"request_id": rid(), "file_hash": paper["file_hash"], "content": "这篇论文的方法有哪些局限？", "selected_pages": [1], **changes}


def model(client, replies=None):
    requests = []
    def handler(request):
        body = json.loads(request.content); requests.append(body)
        value = replies.pop(0) if replies else {"answer": "模拟讨论：当前页没有可确认的论文结论，请结合原文继续核对。", "citations": [{"source_page": 1, "excerpt": "合成样本", "description": "流程验证"}]}
        text = json.dumps(value, ensure_ascii=False)
        return httpx.Response(200, json={"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}], "usage": {"input_tokens": 100, "output_tokens": 200}})
    client.app.state.card_runner.provider_factory = lambda options, key, local: VisionProvider(options, key, local, transport=httpx.MockTransport(handler))
    return requests


def send(client, session, paper, **changes):
    payload = request(paper, **changes)
    result = client.post(f"/api/v1/discussions/{session['id']}/messages", json=payload)
    assert result.status_code == 202, result.text
    return result.json(), payload


def test_session_and_message_idempotency_and_model_validation(client):
    paper = upload(client); session = new_session(client, paper)
    with client.app.state.session_factory() as db: saved = db.get(DiscussionSession, session['id']); creation = saved.request_id
    assert client.post(f"/api/v1/papers/{paper['id']}/discussions", json={"request_id": creation, "file_hash": paper['file_hash']}).json()['id'] == session['id']
    assert client.post(f"/api/v1/discussions/{session['id']}/messages", json=request(paper)).status_code == 409
    configure(client); calls = model(client)
    task, payload = send(client, session, paper)
    same = client.post(f"/api/v1/discussions/{session['id']}/messages", json=payload)
    assert same.json()['id'] == task['id']
    assert client.post(f"/api/v1/discussions/{session['id']}/messages", json={**payload, "content": "另一问题"}).status_code == 409
    assert client.post(f"/api/v1/discussions/{session['id']}/messages", json=request(paper)).status_code == 409
    assert run_task(client)['status'] == 'succeeded'
    detail = client.get(f"/api/v1/discussions/{session['id']}").json()
    assert [item['role'] for item in detail['messages']] == ['user','assistant']
    assert detail['messages'][1]['status'] == 'completed' and detail['messages'][1]['evidence'][0]['page_number'] == 1
    assert detail['model']['name'] == 'mock-vision' and len(calls) == 1
    assert not client.get(f"/api/v1/papers/{paper['id']}/card-tasks").json()


def test_followup_uses_completed_history_and_excludes_personal_notes(client):
    configure(client); paper=upload(client); session=new_session(client,paper); calls=model(client)
    send(client,session,paper);run_task(client)
    with client.app.state.session_factory() as db:
        db.add(Note(workspace_id=1,user_id=1,paper_id=paper['id'],file_hash=paper['file_hash'],note_type='personal_insight',content='不应发送的个人笔记',insight_kind='question'));db.commit()
    send(client,session,paper,content='接着解释这种局限的适用条件');run_task(client)
    text=json.dumps(calls[-1],ensure_ascii=False)
    assert '这篇论文的方法有哪些局限' in text and '模拟讨论' in text and '接着解释' in text
    assert '不应发送的个人笔记' not in text
    with client.app.state.session_factory() as db:
        task=db.scalar(select(GenerationTask).order_by(GenerationTask.queue_order.desc()).limit(1))
        assert len(task.input_snapshot['history'])==2
        assert db.scalar(select(func.count()).select_from(ModelCall))==2


def test_discussion_card_is_independent_and_keeps_personal_value_until_confirmation(client):
    configure(client);paper=upload(client);session=new_session(client,paper)
    original=manual(client,paper,personal_value='我的研究用途')['version']
    state=card_state(client,paper)
    assert client.post(f"/api/v1/card-versions/{original['id']}/confirm",json={'request_id':rid(),'card_revision':state['card_revision']}).status_code==200
    before=card_state(client,paper);model(client);send(client,session,paper);run_task(client)
    output=wire(summary='模拟整理：根据本段讨论生成的独立草稿。')
    output['limitations']=[{'text':'讨论小结：用户在讨论中提出需要进一步核对泛化条件。','origin':'user_record','evidence':[]}]
    calls=model(client,[output])
    response=client.post(f"/api/v1/discussions/{session['id']}/card-tasks",json=request(paper,content=None))
    assert response.status_code==202,response.text
    job=run_task(client);assert job['status']=='succeeded',job
    state=card_state(client,paper)
    assert state['current_version_id']==original['id'] and state['card_revision']==before['card_revision']
    latest=state['versions'][0]
    assert latest['confirmed_at'] is None and latest['data']['personal_value']=='我的研究用途'
    assert latest['model_info']['discussion_session_id']==session['id'] and len(latest['model_info']['discussion_message_ids'])==2
    assert '我的研究用途' not in json.dumps(calls,ensure_ascii=False)
    assert client.post(f"/api/v1/card-versions/{latest['id']}/confirm",json={'request_id':rid(),'card_revision':state['card_revision']}).status_code==200
    assert card_state(client,paper)['current_version_id']==latest['id']


def test_invalid_citation_and_cancelled_late_response_do_not_write_answer(client):
    configure(client);paper=upload(client);session=new_session(client,paper)
    bad={'answer':'模拟越界来源','citations':[{'source_page':2}]}
    model(client,[bad,bad]);send(client,session,paper);job=run_task(client)
    assert job['status']=='failed' and job['error_code']=='invalid_evidence'
    detail=client.get(f"/api/v1/discussions/{session['id']}").json()
    assert detail['messages'][1]['status']=='failed' and not detail['messages'][1]['content']
    calls=model(client);task,_=send(client,session,paper)
    assert client.post(f"/api/v1/card-tasks/{task['id']}/cancel").json()['status']=='cancelled'
    assert client.app.state.card_runner.claim() is None and not calls


def test_discussion_ideas_cannot_be_paper_findings():
    from app.discussion import card_result
    from app.reading_service import ReadingError
    output=wire()
    output['findings']=[{'text':'科研助手对照实验建议，尚未实施。','origin':'system_inference','evidence':[]}]
    with pytest.raises(ReadingError) as caught:
        card_result(output,{},[])
    assert caught.value.body['code']=='invalid_discussion_claim'


def test_discussion_card_cannot_omit_conversation_takeaway():
    from app.discussion import card_result
    from app.reading_service import ReadingError
    with pytest.raises(ReadingError) as caught:
        card_result(wire(),{},[{'role':'user','content':'我想验证科研助手场景。'}])
    assert caught.value.body['code']=='discussion_summary_missing'


def test_discussion_card_repair_includes_field_length_failure(client):
    configure(client);paper=upload(client);session=new_session(client,paper)
    model(client);send(client,session,paper);run_task(client)
    good=wire();good['limitations']=[{'text':'讨论小结：后续核对适用条件。','origin':'system_inference','evidence':[]}]
    bad=json.loads(json.dumps(good));bad['summary']['text']='长'*151
    calls=model(client,[bad,good])
    assert client.post(f"/api/v1/discussions/{session['id']}/card-tasks",json=request(paper,content=None)).status_code==202
    assert run_task(client)['status']=='succeeded'
    assert len(calls)==2 and '简介第1项当前151字符，上限150字符' in json.dumps(calls[-1],ensure_ascii=False)


def test_context_and_permissions_reject_before_model_and_cleanup_keeps_chat(client):
    configure(client);paper=upload(client);session=new_session(client,paper);calls=model(client)
    for changes in [{'selected_pages':[3]},{'file_hash':'f'*64},{'content':' '},{'selected_pages':[1,2,1,2]}]:
        assert client.post(f"/api/v1/discussions/{session['id']}/messages",json=request(paper,**changes)).status_code in (409,422)
    assert client.post(f"/api/v1/discussions/{session['id']}/card-tasks",json=request(paper,content=None)).status_code==409
    send(client,session,paper);run_task(client)
    with client.app.state.session_factory() as db:
        task=db.scalar(select(GenerationTask));db.delete(task);db.commit()
    detail=client.get(f"/api/v1/discussions/{session['id']}").json()
    assert len(detail['messages'])==2 and detail['messages'][1]['content']
    client.delete('/api/v1/session')
    assert client.get(f"/api/v1/discussions/{session['id']}").status_code==401
    assert len(calls)==1


def test_late_cancelled_reply_is_accounted_but_not_published(client):
    configure(client);paper=upload(client);session=new_session(client,paper);task,_=send(client,session,paper)
    def cancelled(request):
        client.post(f"/api/v1/card-tasks/{task['id']}/cancel")
        return httpx.Response(200,json={'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps({'answer':'不应发布的晚到回答','citations':[]})}]}],'usage':{'input_tokens':100,'output_tokens':200}})
    client.app.state.card_runner.provider_factory=lambda options,key,local:VisionProvider(options,key,local,transport=httpx.MockTransport(cancelled))
    result=run_task(client)
    assert result['status']=='cancelled' and result['charged_tokens']==300
    assert not client.get(f"/api/v1/discussions/{session['id']}").json()['messages'][1]['content']


def test_discussion_budget_and_conversation_limit_block_before_enqueue(client):
    configure(client,max_task_tokens=10000);paper=upload(client);session=new_session(client,paper)
    assert client.post(f"/api/v1/discussions/{session['id']}/messages",json=request(paper)).json()['code']=='task_budget_exceeded'
    configure(client)
    with client.app.state.session_factory() as db:
        db.add(DiscussionMessage(workspace_id=1,user_id=1,paper_id=paper['id'],session_id=session['id'],sequence=1,role='user',content='内容'*28000,status='completed'));db.commit()
    response=client.post(f"/api/v1/discussions/{session['id']}/messages",json=request(paper))
    assert response.status_code==409 and response.json()['code']=='discussion_limit'


def test_cross_user_session_and_paper_cascade(client):
    configure(client);paper=upload(client);session=new_session(client,paper);model(client);send(client,session,paper);run_task(client)
    from app.models import User
    with client.app.state.session_factory() as db:
        user=db.get(User,1);foreign=User(workspace_id=user.workspace_id,username='foreign',password_hash=user.password_hash);db.add(foreign);db.flush()
        db.get(DiscussionSession,session['id']).user_id=foreign.id;db.commit()
    assert client.get(f"/api/v1/discussions/{session['id']}").status_code==404
    with client.app.state.session_factory() as db:
        from app.models import Paper
        db.delete(db.get(Paper,paper['id']));db.commit()
        assert not db.get(DiscussionSession,session['id']) and db.scalar(select(func.count()).select_from(DiscussionMessage))==0


def test_text_context_preserves_actual_pages_and_boundaries(tmp_path):
    from app.ai_render import prepare
    from pypdf import PdfWriter
    from pypdf.generic import DictionaryObject,NameObject,DecodedStreamObject
    writer=PdfWriter()
    for number in range(1,4):
        page=writer.add_blank_page(width=600,height=800)
        font=DictionaryObject({NameObject('/Type'):NameObject('/Font'),NameObject('/Subtype'):NameObject('/Type1'),NameObject('/BaseFont'):NameObject('/Helvetica')})
        page[NameObject('/Resources')]=DictionaryObject({NameObject('/Font'):DictionaryObject({NameObject('/F1'):writer._add_object(font)})})
        content=DecodedStreamObject();content.set_data(f'BT /F1 12 Tf 40 700 Td (Page {number}: bounded research context) Tj ET'.encode())
        page[NameObject('/Contents')]=writer._add_object(content)
    path=tmp_path/'context.pdf';writer.write(path)
    context=json.loads(prepare(path,[3,1,2],'text',40)[0][1])
    assert context['pages'][0]['page_number']==1 and context['pages'][-1]['page_number']==3
    assert sum(len(item['text']) for item in context['pages'])==40
    assert 2 in context['clipped_pages']
