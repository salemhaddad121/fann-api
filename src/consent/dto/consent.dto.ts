import { IsBoolean } from 'class-validator';
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
