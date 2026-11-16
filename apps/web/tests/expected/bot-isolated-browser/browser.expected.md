## In control

- region "Computer":
  - status: You are controlling Display and input are dedicated to this Bot
  - button "Hand back"
  - button "Close computer panel"
  - textbox "Website address":
    - /placeholder: https://example.com
    - text: https://example.test/next
  - button "Open"
  - img "Live computer screen"
  - text: Click, scroll, or type in the screen
  - button "Paste"

## Watching

- region "Computer":
  - status: Watching Display and input are dedicated to this Bot
  - button "Take control"
  - button "Close computer panel"
  - img "Live computer screen"
  - text: Watching only
  - button "Paste" [disabled]

## Saved login approval

- region "Approve website sign-in":
  - text: Approve website sign-in Website
  - code: https://example.test
  - text: Destination
  - code: https://example.test/session
  - link "Approve sign-in":
    - /url: /__yharness/vault-login-use/{{id}}

## Shared login approval

- region "Approve shared website sign-in":
  - text: Approve shared website sign-in Website
  - code: https://example.test
  - text: Destination
  - code: https://example.test/session
  - link "Approve sign-in":
    - /url: /__yharness/vault-login-use/{{id}}

## Shared browser sign-in

- region "Sign in to the shared browser":
  - text: Sign in to the shared browser Sign in on the Computer and return control to continue. Website
  - code: https://example.test
  - button "Cancel"
  - button "Take over"

## Shared browser in control

- region "Computer":
  - status: Private sign-in Display and input are dedicated to this Bot
  - button "I’m done"
  - button "Cancel"
  - button "Close computer panel"
  - textbox "Website address":
    - /placeholder: https://example.com
  - button "Open" [disabled]
  - text: Current website
  - code: https://example.test
  - text: Check the website address before entering details. Finish or clear the sign-in form before returning control.
  - img "Live computer screen"
  - text: Click, scroll, or type in the screen
  - button "Paste"
