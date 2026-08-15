import { IsIn, IsInt, IsNotEmpty, IsPositive, IsString, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';
import { IdDocumentKind } from '../identity-documents.service';

export const ID_DOCUMENT_KINDS = ['id_document', 'selfie'] as const;

export class PresignIdDocumentDto {
  @IsIn(ID_DOCUMENT_KINDS)
  kind: IdDocumentKind;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  fileSizeBytes: number;
}

export class ConfirmIdDocumentDto {
  @IsIn(ID_DOCUMENT_KINDS)
  kind: IdDocumentKind;

  // Returned by presign. Checked server-side against the caller's own
  // prefix rather than trusted — see IdentityDocumentsService.confirm().
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  s3Key: string;
}
