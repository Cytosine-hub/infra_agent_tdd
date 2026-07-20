"use client";

import { useCallback, useEffect, useState } from "react";
import type { AttachmentRow } from "@/lib/db";

// 需求附件卡片：图片缩略预览 + 文档下载；提交人/组长可补传与删除
export default function AttachmentsCard({
  requirementId,
  canManage,
}: {
  requirementId: number;
  canManage: boolean;
}) {
  const [atts, setAtts] = useState<AttachmentRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    fetch(`/api/requirements/${requirementId}/attachments`)
      .then((r) => (r.ok ? r.json() : { attachments: [] }))
      .then((d) => setAtts(d.attachments));
  }, [requirementId]);
  useEffect(load, [load]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError("");
    const fd = new FormData();
    Array.from(files).forEach((f) => fd.append("file", f));
    const res = await fetch(`/api/requirements/${requirementId}/attachments`, {
      method: "POST",
      body: fd,
    });
    setBusy(false);
    if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? "上传失败");
    load();
  }

  async function remove(id: number) {
    if (!window.confirm("确定删除该附件？")) return;
    await fetch(`/api/attachments/${id}`, { method: "DELETE" });
    load();
  }

  if (atts.length === 0 && !canManage) return null;

  return (
    <section className="card mt-5 p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-zinc-500">附件（{atts.length}）</h2>
        {canManage && (
          <label className="btn-secondary !px-2.5 !py-1 cursor-pointer text-xs">
            {busy ? "上传中…" : "＋ 上传附件"}
            <input
              type="file"
              multiple
              className="hidden"
              disabled={busy}
              onChange={(e) => {
                upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}

      {atts.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {atts.map((a) => {
            const isImage = a.mime.startsWith("image/");
            const url = `/api/attachments/${a.id}`;
            return (
              <div key={a.id} className="group relative w-36">
                <a href={url} target="_blank" className="block">
                  {isImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={url}
                      alt={a.filename}
                      className="h-24 w-36 rounded-lg border border-zinc-200 object-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-36 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50 text-3xl">
                      📄
                    </div>
                  )}
                </a>
                <div className="mt-1 truncate text-[11px] text-zinc-500" title={a.filename}>
                  {a.filename}
                </div>
                <div className="text-[10px] text-zinc-400">{Math.ceil(a.size / 1024)} KB</div>
                {canManage && (
                  <button
                    className="absolute -right-1.5 -top-1.5 hidden h-5 w-5 items-center justify-center rounded-full bg-red-500 text-xs text-white group-hover:flex"
                    onClick={() => remove(a.id)}
                    title="删除"
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
