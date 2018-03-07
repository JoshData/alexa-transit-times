Alexa Transit Times Skill
=========================

By [Joshua Tauberer](https://razor.occams.info).

This is an Alexa skill for Amazon Echo for getting next bus and train times for your common public transit trips such as your morning commute, using your voice. The skill currently works in the Washington, D.C. metro area using real time data from [WMATA](https://developer.wmata.com/).

> *Alexa, ask public transit for times to work.*

Get started by adding the **Next Public Transit Times (DC metro area)** skill.

![Alexa Transit Times Skill Logo](logo-large.png)

## How to use this skill

Here is an example dialog between you and your Echo that shows how you can use this skill:

> Alexa, open public transit.
>
> *Start by adding a trip. For instance, say "add a trip named work" to get started.*
>
> Add a trip named work.
>
> *What is the address of where you're leaving from when you go to work? Say the street address, city, and state.*
>
> 25 Massachusetts Ave Northwest, Washington, DC
>
> *And what is the address of where you're going to when you go to work? Say the street address, city, and state.*
>
> 3001 Connecticut Ave Northwest, Washington, DC
>
> *I've added a trip named work from 25 Massachusetts Ave NW, Washington, DC 20001 to 3001 Connecticut Ave NW, Washington, DC 20008 with 4 routes. To get the times, say 'check times to work'.*
>
> Stop.
>
> _skill exits_
>
> Alexa, ask public transit for times to work.
>
> *At MASSACHUSETTS avenue northwest and G street northwest a 96 arrives in 7 minutes. Then a 96 arrives in 23 minutes.*

## Trip management

After adding one or more trips, you can list, remove, or learn more about your saved trips.

> Alexa, open public transit.
>
> *You have 1 trip stored. You can get next transit times by saying get times to "work." To add a trip, say "add a trip named work" or give it another name. You can also list trips or get more information about your saved trips. Say stop or cancel to exit this skill.*
>
> List trips.
>
> *You have 1 trip: "work." Say "tell me about work" for more information. Or "remove trip named work" to remove it.*
>
> Tell me about work.
>
> *"work" is your trip from 25 Massachusetts Ave NW, Washington, DC 20001 to 3001 Connecticut Ave NW, Washington, DC 20008. A Red Line train at Union Station takes you to Woodley Park with a total travel time of 34 minutes with about 22 minutes of walking. A 96 bus going WEST toward TENLEYTOWN STATION at MASSACHUSETTS avenue northwest and G street northwest takes you to CATHEDRAL avenue northwest and 29TH street northwest with a total travel time of 43 minutes with about 9 minutes of walking....*
>
> Remove trip named work.
>
> *I removed the trip named work.*
>
> Stop.
>
> _skill exits_


## Privacy policy and terms of use

### Privacy Policy

The Alexa Transit Times Skill uses information about where you are and where you are going to provide you with public transit information. When you add a trip using the skill, you provide the street address of where you're leaving from (usually you're home address) and your destination. The street address is stored on our server so that we can compute the best public transit routes when you ask for the skill for train and bus times in the future.

We do not use any of the information we collect in ways that would not be obvious to you. We do not share your information with other parties without your permission except those parties that handle basic web infrastructure for us. We might share or publish aggregate statistics about our users in a way that does not reveal information about you.

Our service is provided as-is. We make no claims to accuracy. Check bus and train routes before you get on! Don't use the skill if using it could cause harm to yourself or others!

WMATA Transit information provided by this skill is subject to change without notice. For the most current information, please [click here](https://www.wmata.com/schedules/trip-planner/) for the WMATA trip planner.

## Skill development

This skill is open source. To try it out yourself, you can get the source code from this repository.

To try out the trip planning functionality from the command-line, you can run:

	node trip-planner.js "25 Massachusetts Ave Northwest, Washington, DC" "3001 Connecticut Ave Northwest, Washington, DC"

Or if you develop with the Alexa tester, start the skill server:

	node index.js PORT

## Credits, license, and contributing

Logo uses the images [Train by Michael Zenaty from the Noun Project](https://thenounproject.com/search/?q=train&i=21833#_=_) and [Bus by Jens Tärning from the Noun Project](https://thenounproject.com/search/?q=bus&i=386494).

This project is dedicated to the public domain. Copyright and related rights in the work worldwide are waived through the [CC0 1.0 Universal public domain dedication](http://creativecommons.org/publicdomain/zero/1.0/). All contributions to this project must be released under the CC0 dedication. By submitting a pull request, you are agreeing to comply with this waiver of your copyright interest.
