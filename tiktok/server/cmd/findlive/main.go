// findlive prints a few currently-live TikTok streams from the recommended
// feed — handy for picking a username to test the live bridge with.
package main

import (
	"fmt"
	"log"

	gotiktoklive "github.com/steampoweredtaco/gotiktoklive"
)

func main() {
	t, err := gotiktoklive.NewTikTok(gotiktoklive.DisableSigningLimitsValidation)
	if err != nil {
		log.Fatal(err)
	}
	feed := t.NewFeed()
	item, err := feed.Next()
	if err != nil {
		log.Fatal(err)
	}
	for _, s := range item.LiveStreams {
		if s.Room == nil || s.Room.Owner == nil {
			continue
		}
		fmt.Printf("@%s\t%d viewers\t%s\n",
			s.Room.Owner.Username, s.Room.UserCount, s.Room.Title)
	}
}
