export interface UploadedFile {
  id: string
  ownerUserId: string
  filename: string
  mediaType: string
  size: number
  objectKey: string
  multipartId: string
  downloadToken: string
  etag: string | null
  outboundSendId: string | null
  createdAt: number
}

const COLUMNS = `id, owner_user_id AS ownerUserId, filename, media_type AS mediaType,
  size, object_key AS objectKey, multipart_id AS multipartId, download_token AS downloadToken,
  etag, outbound_send_id AS outboundSendId, created_at AS createdAt`

export class UploadedFileRepository {
  private readonly db: D1Database

  constructor(db: D1Database) {
    this.db = db
  }

  async create(file: UploadedFile): Promise<void> {
    await this.db
      .prepare(`INSERT INTO uploaded_files
      (id, owner_user_id, filename, media_type, size, object_key, multipart_id, download_token, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        file.id,
        file.ownerUserId,
        file.filename,
        file.mediaType,
        file.size,
        file.objectKey,
        file.multipartId,
        file.downloadToken,
        file.createdAt,
      )
      .run()
  }

  async owned(id: string, ownerUserId: string): Promise<UploadedFile | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM uploaded_files WHERE id = ? AND owner_user_id = ?`)
      .bind(id, ownerUserId)
      .first<UploadedFile>()
  }

  async complete(id: string, ownerUserId: string, etag: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE uploaded_files SET etag = ? WHERE id = ? AND owner_user_id = ? AND etag IS NULL`,
      )
      .bind(etag, id, ownerUserId)
      .run()
  }

  async attach(id: string, ownerUserId: string, sendId: string): Promise<void> {
    const result = await this.db
      .prepare(`UPDATE uploaded_files SET outbound_send_id = ?
      WHERE id = ? AND owner_user_id = ? AND etag IS NOT NULL
      AND (outbound_send_id IS NULL OR outbound_send_id = ?)`)
      .bind(sendId, id, ownerUserId, sendId)
      .run()
    if (result.meta.changes !== 1) throw new Error('Upload already attached or unavailable')
  }

  async shared(token: string): Promise<UploadedFile | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM uploaded_files WHERE download_token = ?
      AND etag IS NOT NULL AND outbound_send_id IN (
        SELECT id FROM outbound_sends WHERE state IN ('sending', 'sent', 'unknown')
      )`)
      .bind(token)
      .first<UploadedFile>()
  }

  async forMessage(
    id: string,
    messageId: string,
    ownerUserId: string,
  ): Promise<UploadedFile | null> {
    return this.db
      .prepare(`SELECT ${COLUMNS} FROM uploaded_files WHERE id = ? AND owner_user_id = ?
      AND outbound_send_id IN (SELECT outbound_sends.id FROM outbound_sends
        INNER JOIN mailbox_members ON mailbox_members.mailbox_id = outbound_sends.mailbox_id
        WHERE message_id = ? AND mailbox_members.user_id = uploaded_files.owner_user_id)`)
      .bind(id, ownerUserId, messageId)
      .first<UploadedFile>()
  }
}
