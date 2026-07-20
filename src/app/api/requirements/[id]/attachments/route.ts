import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { addAttachment, addEvent, getRequirement, listAttachments } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { apiHandler, badRequest, forbidden } from "@/lib/api";
import { ensureUploadsDir, MAX_ATTACHMENT_SIZE, safeFilename } from "@/lib/uploads";

export const GET = apiHandler(
  async (_req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    await requireUser();
    const id = Number((await ctx.params).id);
    if (!getRequirement(id)) return badRequest("需求不存在");
    return NextResponse.json({ attachments: listAttachments(id) });
  }
);

// 上传附件（multipart form-data，field 名 file，可多个）
export const POST = apiHandler(
  async (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const user = await requireUser();
    const id = Number((await ctx.params).id);
    const requirement = getRequirement(id);
    if (!requirement) return badRequest("需求不存在");
    const canUpload =
      user.username === requirement.createdBy ||
      user.role === "admin" ||
      (user.role === "lead" && user.team === requirement.team);
    if (!canUpload) return forbidden("仅需求提交人或本组组长可上传附件");
    if (listAttachments(id).length >= 20) return badRequest("附件数量已达上限（20 个）");

    const form = await req.formData();
    const files = form.getAll("file").filter((f): f is File => f instanceof File);
    if (files.length === 0) return badRequest("未收到文件");

    const dir = ensureUploadsDir(id);
    const saved = [];
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT_SIZE) {
        return badRequest(`文件「${f.name}」超过 15MB 限制`);
      }
      const name = safeFilename(f.name);
      const stored = path.join(dir, `${Date.now()}-${name}`);
      fs.writeFileSync(stored, Buffer.from(await f.arrayBuffer()));
      saved.push(
        addAttachment({
          requirementId: id,
          filename: name,
          storedPath: stored,
          mime: f.type || "application/octet-stream",
          size: f.size,
          uploadedBy: user.username,
        })
      );
    }
    addEvent(id, "attachment_added", user.username, `上传附件：${saved.map((a) => a.filename).join("、")}`);
    return NextResponse.json({ attachments: saved }, { status: 201 });
  }
);
