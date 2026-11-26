import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
} from 'class-validator';

export class UploadPartsDto {
  @IsString()
  @IsNotEmpty()
  uploadId: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  partNumbers: number[];
}
