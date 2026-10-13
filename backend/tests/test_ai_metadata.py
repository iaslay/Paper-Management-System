"""论文信息识别与显式保存的端到端验证，不调用真实云端。"""
import base64
import io
import json
import httpx
from pypdf import PdfReader
from sqlalchemy import select
from app.models import GenerationTask, PaperCard
from app import ai_metadata
from app import reading_service as reading
from test_ai_cards import client, configure, mock_model, run_task, rid
from test_management import upload, pdf, label
from test_reading import create_note


def wire(title="原文识别标题", page=1, labels=()):
    return {"title":{"value":title,"source_pages":[page]},"authors":{"value":["Alice Example","Bob Example"],"source_pages":[1]},"year":{"value":2024,"source_pages":[1]},"doi":{"value":"https://doi.org/10.1234/example","source_pages":[page]},"classifications":list(labels)}


def candidate(name="新主题", kind="topic", tag_id=None):
    return {"name":name,"kind":kind,"tag_id":tag_id,"reason":"根据论文问题归纳","source_pages":[1]}


def enqueue(client,paper,**changes):
    payload={"request_id":rid(),**changes}
    response=client.post(f"/api/v1/papers/{paper['id']}/metadata-tasks",json=payload)
    assert response.status_code==202,response.text
    return response.json(),payload


def model(client,value,requests=None):
    requests=requests if requests is not None else []
    def handle(request,body,number):
        requests.append(body)
        text=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False)
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":text}]}],"usage":{"input_tokens":500,"output_tokens":300}})
    mock_model(client,response_hook=handle)
    return requests


def test_metadata_uses_selected_pages_and_never_changes_paper_until_save(client):
    configure(client);paper=upload(client,content=pdf("旧文件名",pages=8));note=create_note(client,paper,content="不发送的私人理解")
    direction=label(client,"已有方向")
    requests=model(client,wire(page=5,labels=[candidate("已有方向","research_direction",direction["id"]),candidate()]))
    task,_=enqueue(client,paper);finished=run_task(client)
    assert finished["status"]=="succeeded",finished
    result=finished["metadata"]
    assert result["analyzed_pages"]==[1,2,3,4,8] and result["fields"]["doi"]["sources"][0]["page_number"]==8
    attachment=next(part for part in requests[0]["input"][0]["content"] if part["type"]=="input_file")
    assert len(PdfReader(io.BytesIO(base64.b64decode(attachment["file_data"].split(",",1)[1]))).pages)==5
    assert "不发送的私人理解" not in json.dumps(requests,ensure_ascii=False)
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["title"]==paper["title"]
    assert client.get(f"/api/v1/notes/{note['id']}").json()["content"]=="不发送的私人理解"
    assert len(client.get("/api/v1/tags").json())==1
    assert client.get(f"/api/v1/papers/{paper['id']}/card-tasks").json()==[]
    assert len(client.get(f"/api/v1/papers/{paper['id']}/metadata-tasks").json())==1
    with client.app.state.session_factory() as db:
        assert db.get(PaperCard,paper["id"]) is None and db.get(GenerationTask,task["id"]).input_snapshot["notes"]==[]


def test_metadata_save_is_atomic_idempotent_and_preserves_status(client):
    paper=upload(client);direction=label(client,"检索方向",aliases=["RAG"])
    path=f"/api/v1/papers/{paper['id']}"
    body={"request_id":rid(),"file_hash":paper["file_hash"],"revision":paper["revision"],"title":"识别并核对后的标题","authors":["Alice Example"],"year":2024,"doi":"10.1234/example","new_labels":[{"kind":"research_direction","name":"RAG"},{"kind":"topic","name":"新主题"},{"kind":"general","name":"新标签"}]}
    first=client.patch(path,json=body)
    assert first.status_code==200,first.text
    assert first.json()["reading_status"]==paper["reading_status"] and first.json()["file_hash"]==paper["file_hash"]
    assert first.json()["research_directions"][0]["id"]==direction["id"]
    assert first.json()["topics"][0]["name"]=="新主题"
    again=client.patch(path,json=body)
    assert again.json()==first.json() and len(client.get("/api/v1/tags").json())==3
    reused=client.patch(path,json={**body,"title":"不同输入"})
    assert reused.status_code==409 and reused.json()["code"]=="request_id_reused"


def test_failed_metadata_keeps_original_information(client):
    configure(client);paper=upload(client);requests=model(client,"格式错误")
    enqueue(client,paper);finished=run_task(client)
    assert finished["status"]=="failed" and finished["metadata"] is None and len(requests)==2
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["title"]==paper["title"]


def test_metadata_retry_is_cached_and_cannot_reuse_card_request_id(client):
    configure(client);paper=upload(client);task,payload=enqueue(client,paper)
    path=f"/api/v1/papers/{paper['id']}/metadata-tasks"
    assert client.post(path,json=payload).json()["id"]==task["id"]
    assert client.post(path,json={"request_id":rid()}).json()["id"]==task["id"]
    other=client.post(f"/api/v1/papers/{paper['id']}/card-tasks",json=payload)
    assert other.status_code==409 and other.json()["code"]=="request_id_reused"
    assert client.post(path,json={**payload,"note_ids":[]}).status_code==422


def test_invalid_metadata_sources_and_missing_fields():
    import pytest
    pages={1:{"id":"a"*32,"page_number":7}}
    value=wire(page=2)
    with pytest.raises(reading.ReadingError):ai_metadata.normalize(value,pages,[])
    value=wire();value["doi"]={"value":None,"source_pages":[]};value["year"]={"value":None,"source_pages":[]}
    data,_=ai_metadata.normalize(value,pages,[])
    assert data["fields"]["doi"]["value"] is None and data["fields"]["title"]["sources"][0]["page_number"]==7


def test_wrong_classification_type_does_not_block_valid_fields():
    raw=wire(labels=[candidate("错误分类","topic",5)])
    data,warnings=ai_metadata.normalize(raw,{1:{"id":"a"*32,"page_number":1}},[{"id":5,"kind":"research_direction","name":"现有方向","aliases":[]}])
    assert data["fields"]["title"]["value"] and data["classifications"]==[] and warnings


def test_classification_limit_rolls_back_new_tag_and_metadata(client):
    paper=upload(client);directions=[label(client,f"方向{i}")["id"] for i in range(10)]
    updated=client.patch(f"/api/v1/papers/{paper['id']}",json={"revision":paper["revision"],"research_direction_ids":directions}).json()
    body={"request_id":rid(),"file_hash":paper["file_hash"],"revision":updated["revision"],"title":"不能写入的新标题","new_labels":[{"name":"超过上限的方向","kind":"research_direction"}]}
    result=client.patch(f"/api/v1/papers/{paper['id']}",json=body)
    assert result.status_code==422 and len(client.get("/api/v1/tags").json())==10
    assert client.get(f"/api/v1/papers/{paper['id']}").json()["title"]==paper["title"]


def test_metadata_batching_restores_original_page_sources(client):
    configure(client,batch_pages=2,max_task_tokens=5000000,monthly_token_limit=10000000)
    paper=upload(client,content=pdf("长论文",pages=7));requests=model(client,wire())
    enqueue(client,paper);finished=run_task(client)
    assert finished["status"]=="succeeded",finished
    assert len(requests)==3 and finished["metadata"]["analyzed_pages"]==[1,2,3,4,7]
    assert finished["metadata"]["fields"]["title"]["sources"][0]["page_number"]==1


def test_cancellation_prevents_late_metadata_publication(client):
    configure(client);paper=upload(client);task,_=enqueue(client,paper)
    def hook(request,body,number):
        assert client.post(f"/api/v1/card-tasks/{task['id']}/cancel").status_code==200
        return httpx.Response(200,json={"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":json.dumps(wire())}]}],"usage":{"input_tokens":500,"output_tokens":300}})
    mock_model(client,response_hook=hook);finished=run_task(client)
    assert finished["status"]=="cancelled" and finished["metadata"] is None and finished["charged_tokens"]==800
