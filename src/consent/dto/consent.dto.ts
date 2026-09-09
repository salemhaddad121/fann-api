import { ArrayNotEmpty, IsArray, IsBoolean, IsIn } from 'class-validator';
import { MANDATORY_DOCUMENTS } from '../consent.constants';
import { StrictBoolean } from '../../common/boolean.transform';

export class SetMarketingConsentDto {
  // @IsBoolean, not @Equals — unlike the signup checkboxes, `false` is the
  // whole point here. It is what a withdrawal looks like.
  //
  // Which is exactly why @StrictBoolean matters more here than anywhere:
  // the global pipe would otherwise turn the string "false" into `true`,
  // so an attempt to WITHDRAW consent would be recorded as granting it.
  @StrictBoolean()
  @IsBoolean({ message: 'granted must be true or false.' })
  granted: boolean;
}

export class AcceptDocumentsDto {
  // Restricted to the mandatory documents on purpose. This endpoint exists
  // for re-acceptance after an amendment (§33.2); routing marketing through
  // it would let an opt-in be recorded by a flow that has no checkbox and
  // no wording attached to it, which is precisely what §24.2 forbids.
  // Marketing has its own PUT.
  @IsArray()
  @ArrayNotEmpty({ message: 'Name at least one document to accept.' })
  @IsIn(MANDATORY_DOCUMENTS as readonly string[], {
    each: true,
    message: 'Unknown document.',
  })
  documents: string[];
}
