## Shared workspace and Internet enabled

- region "Computer":
  - status: Watching Display and input are dedicated to this Bot
  - button "Take control"
  - button "Close computer panel"
  - text: Internet for Terminal & apps Controls Internet access for this Bot’s terminal and apps.
  - switch "Allow Internet for Terminal & apps" [checked]
  - text: Shared workspace Grants this Bot access to common project files.
  - switch "Allow access to common project files" [checked]
  - img "Live computer screen"
  - text: Watching only
  - button "Restart computer"
  - button "Paste" [disabled]

## Restart confirmation

- region "Computer":
  - status: Computer connection lost Display and input are dedicated to this Bot
  - button "Retry"
  - button "Take control"
  - button "Close computer panel"
  - text: Internet for Terminal & apps Controls Internet access for this Bot’s terminal and apps.
  - switch "Allow Internet for Terminal & apps" [checked]
  - text: Shared workspace Grants this Bot access to common project files.
  - switch "Allow access to common project files"
  - paragraph: Running apps will close. Saved files and your browser profile will persist.
  - button "Cancel"
  - button "Restart"
  - img "Live computer screen"
  - text: Watching only
  - button "Paste" [disabled]

## Waiting in chat

- region "Your bot needs you to sign in":
  - text: Your bot needs you to sign in Sign in on the Computer and return control to continue.
  - button "Cancel"
  - button "Take over"

## In control

- region "Computer":
  - status: Private sign-in Display and input are dedicated to this Bot
  - button "I’m done"
  - button "Cancel"
  - button "Close computer panel"
  - text: Internet for Terminal & apps Controls Internet access for this Bot’s terminal and apps.
  - switch "Allow Internet for Terminal & apps" [checked]
  - text: Shared workspace Grants this Bot access to common project files.
  - switch "Allow access to common project files" [disabled]
  - text: Check the website address before entering details. Finish or clear the sign-in form before returning control.
  - img "Live computer screen"
  - text: Click, scroll, or type in the screen
  - button "Paste"
